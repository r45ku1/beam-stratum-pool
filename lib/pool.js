const tls = require('tls');

var events = require('events');
var async = require('async');
var net = require('net');

var varDiff = require('./varDiff.js');
// var daemon = require('./daemon.js');
var peer = require('./peer.js');
var stratum = require('./stratum.js');
var jobManager = require('./jobManager.js');
var util = require('./util.js');
const u2 = require('util');

var fork1 = 0;
var fork2 = 0;

// Configure this
const BEAM_STRATUM_PORT = 3333;

var pool = module.exports = function pool(options, authorizeFn) {

    this.options = options;

    var _this = this;
    var blockPollingIntervalId;


    var emitLog = function (text) {
        _this.emit('log', 'debug', text);
    };
    var emitWarningLog = function (text) {
        _this.emit('log', 'warning', text);
    };
    var emitErrorLog = function (text) {
        _this.emit('log', 'error', text);
    };
    var emitSpecialLog = function (text) {
        _this.emit('log', 'special', text);
    };


    if (!(options.coin.algorithm in algos)) {
        emitErrorLog('The ' + options.coin.algorithm + ' hashing algorithm is not supported.');
        throw new Error();
    }
    

    this.start = function () {
        SetupVarDiff();
        SetupJobManager();
        SetupDaemonInterface()
        StartStratumServer(function () {
            OutputPoolInfo();
            _this.emit('started');
        });
    };


    function OutputPoolInfo() {
        console.log("Started Pool");
    }



    function SetupVarDiff() {
        _this.varDiff = {};
        Object.keys(options.ports).forEach(function (port) {
            if (options.ports[port].varDiff)
                _this.setVarDiff(port, options.ports[port].varDiff);
        });
    }



    var jobManagerLastSubmitBlockHex = false;

    function SetupJobManager() {
        _this.jobManager = new jobManager(options);

        _this.jobManager.on('newBlock', function (blockTemplate) {
            if (_this.stratumServer) {
                _this.stratumServer.broadcastMiningJobs(blockTemplate);
            }
        }).on('updatedBlock', function (blockTemplate) {
            if (_this.stratumServer) {
                var job = blockTemplate.rpcData;
                _this.stratumServer.broadcastMiningJobs(job);
            }
        }).on('share', function (shareData, blockHex) {

            var isValidShare = !shareData.error;
            var isValidBlock = !!blockHex;

            var emitShare = function () {
                _this.emit('share', isValidShare, isValidBlock, shareData);
            };


            if (!isValidBlock)
                emitShare();
            else {
                if (jobManagerLastSubmitBlockHex === blockHex) {
                    emitWarningLog('Warning, ignored duplicate submit block ' + blockHex);
                } else {
                    console.log("SubmitBlock shareData:" + JSON.stringify(shareData) + "blockHex=" + blockHex.toString('hex'));
                    jobManagerLastSubmitBlockHex = blockHex;

		    const submitJson = {
			id: shareData.id,
			jsonrpc: "2.0",
			method: "solution",
			nonce: shareData.nonce,
			output: shareData.output
		    };

		    _this.daemon.write(JSON.stringify(submitJson) + "\n"); 
	        _this.emit('block', shareData);
                }
            }
        }).on('log', function (severity, message) {
            _this.emit('log', severity, message);
        });
    }



    // TODO: Make this async
    function SetupDaemonInterface() {
        process.env["NODE_TLS_REJECT_UNAUTHORIZED"] = 0;
        _this.daemon = tls.connect(BEAM_STRATUM_PORT, options, () => {
            console.log('BEAM Stratum connected');
        });
        _this.daemon.setEncoding('utf8');

        _this.daemon.on('data', (data, callback) => {

            let reply = JSON.parse(data);
            let method = reply['method'];
            switch (method) {
                case 'result':
			    console.log("reply from stratum: " + JSON.stringify(reply));
                    const blockHash = reply['blockhash'];
		    const description = reply['description'];
		    if (description == "accepted" && blockHash) {
			    if (!blockHash) {
				console.log("\n\n*********** BLOCK REJECTED !!\n\n");
			} else {
			 	_this.emit('blockupdate', reply);
			}
			return;
		    } else if (reply.id == "login") {
			    if (description == "failed") {
				console.log("LOGIN FAILED!!!");
			    	return;
			    } else {
			    	fork1 = reply.forkheight || 0;
			    	fork2 = reply.forkheight2 || 0;
			    	_this.jobManager.setForkHeights(fork1, fork2);
			    	if (_this.stratumServer) _this.stratumServer.setForks(fork1, fork2);
				console.log("LOGIN OK");
				    //_this.emit('authorized', reply);
			    }	    
		    }

                    break;
                case 'job':
                    let rpcData = reply;
                    emitWarningLog("[NODE]> JOB id:" + rpcData.id + " height:" + rpcData.height);
                    const unpackedDiff = util.beamDiffUnpack(rpcData.difficulty);
                    rpcData.difficulty = unpackedDiff;

                    if (!_this.jobManager) {
                        console.log("No current job");
                    }
                    _this.jobManager.processTemplate(rpcData);

                    break;

                default:
                    console.log(`\n\n\n***** Unhandled method: ${method}`);
            }
        });
        _this.daemon.on('error', function (error) {
				    console.error(error);
            _this.daemon.destroy();
        });
        _this.daemon.on('end', () => {
            console.log('server ends transmission');
	  _this.daemon = tls.connect(BEAM_STRATUM_PORT, options, () => {
            console.log('client connected',
                _this.daemon.authorized ? 'authorized from CA' : 'unauthorized from CA');
            //process.stdin.pipe(_this.daemon);
            //process.stdin.resume();
        });
        });

        // todo read from pooolconfig
        let loginJson = {
            "method": "login",
            "api_key": "aaaa1234",
            "id": "login",
            "jsonrpc": "2.0"
        }
        _this.daemon.write(JSON.stringify(loginJson) + "\n");

    }



    function StartStratumServer(finishedCallback) {
        _this.stratumServer = new stratum.Server({
            counter: _this.jobManager.extraNonceCounter,
            ...options
        }, authorizeFn);
        
        _this.stratumServer.setForks(fork1, fork2);

        _this.stratumServer.on('started', function () {
            //options.initStats.stratumPorts = Object.keys(options.ports);
            //_this.stratumServer.broadcastMiningJobs(_this.jobManager.currentJob.getJobParams());
            finishedCallback();


        }).on('broadcastTimeout', function () {
            emitWarningLog('\n\n****** No new blocks for ' + options.jobRebroadcastTimeout + ' seconds - updating transactions & rebroadcasting work');

            // todo read from pooolconfig
            let loginJson = {
                "method": "login",
                "api_key": "aaaa1234",
                "id": "login",
                "jsonrpc": "2.0"
            }
          _this.daemon.write(JSON.stringify(loginJson) + "\n");


        }).on('client.connected', function (client) {
            if (typeof (_this.varDiff[client.socket.localPort]) !== 'undefined') {
                _this.varDiff[client.socket.localPort].manageClient(client);
            }

            client.on('difficultyChanged', function (diff) {
                _this.emit('difficultyUpdate', client.workerName, diff, client.poolWorkerId);

            }).on('authorized', function (params, resultCallback) {

                if (_this.jobManager.currentJob) {
                    this.sendMiningJob(_this.jobManager.currentJob);
                }
            }).on('submit', function (params, resultCallback) {
                var result = _this.jobManager.processShare(
                    params.id,
                    client.previousDifficulty,
                    client.userSetDifficulty,
                    client.extraNonce1,
                    params.extraNonce2,
                    params.nonce,
                    client.remoteAddress,
                    client.socket.localPort,
                    params.name,
                    params.output,
                    client.poolWorkerId,
                    client.poolUserId,
                    client.poolCoinId
                );

                resultCallback(result.error, result.code < 0 ? true : null);

            }).on('malformedMessage', function (message) {
                emitWarningLog('Malformed message from ' + client.getLabel() + ': ' + message);

            }).on('socketError', function (err) {
                emitWarningLog('Socket error from ' + client.getLabel() + ': ' + JSON.stringify(err));

            }).on('socketTimeout', function (reason) {
                emitWarningLog('Connected timed out for ' + client.getLabel() + ': ' + reason)

            }).on('socketDisconnect', function (poolWorkerId) {
                _this.emit('minerDisconnect', poolWorkerId);

            }).on('kickedBannedIP', function (remainingBanTime) {
                emitLog('Rejected incoming connection from ' + client.remoteAddress + ' banned for ' + remainingBanTime + ' more seconds');

            }).on('forgaveBannedIP', function () {
                emitLog('Forgave banned IP ' + client.remoteAddress);

            }).on('unknownStratumMethod', function (fullMessage) {
                emitLog('Unknown stratum method from ' + client.getLabel() + ': ' + fullMessage.method);

            }).on('socketFlooded', function () {
                emitWarningLog('Detected socket flooding from ' + client.getLabel());

            }).on('tcpProxyError', function (data) {
                emitErrorLog('Client IP detection failed, tcpProxyProtocol is enabled yet did not receive proxy protocol message, instead got data: ' + data);

            }).on('bootedBannedWorker', function () {
                emitWarningLog('Booted worker ' + client.getLabel() + ' who was connected from an IP address that was just banned');

            }).on('triggerBan', function (reason) {
                emitWarningLog('Banned triggered for ' + client.getLabel() + ': ' + reason);
                _this.emit('banIP', client.remoteAddress, client.workerName);
            });
        });
    }


    function CheckBlockAccepted(blockHash, callback) {
        //setTimeout(function(){
        _this.daemon.cmd('getblock',
            [blockHash],
            function (results) {
                var validResults = results.filter(function (result) {
                    return result.response && (result.response.hash === blockHash)
                });
                // do we have any results?
                if (validResults.length >= 1) {
                    // check for invalid blocks with negative confirmations
                    if (validResults[0].response.confirmations >= 0) {
                        // accepted valid block!
                        callback(true, validResults[0].response.tx[0]);
                    } else {
                        // reject invalid block, due to confirmations
                        callback(false, {
                            "confirmations": validResults[0].response.confirmations
                        });
                    }
                    return;
                }
                // invalid block, rejected
                callback(false, {
                    "unknown": "check coin daemon logs"
                });
            }
        );
    }


    this.relinquishMiners = function (filterFn, resultCback) {
        var origStratumClients = this.stratumServer.getStratumClients();

        var stratumClients = [];
        Object.keys(origStratumClients).forEach(function (subId) {
            stratumClients.push({
                subId: subId,
                client: origStratumClients[subId]
            });
        });
        async.filter(
            stratumClients,
            filterFn,
            function (clientsToRelinquish) {
                clientsToRelinquish.forEach(function (cObj) {
                    cObj.client.removeAllListeners();
                    _this.stratumServer.removeStratumClientBySubId(cObj.subId);
                });

                process.nextTick(function () {
                    resultCback(
                        clientsToRelinquish.map(
                            function (item) {
                                return item.client;
                            }
                        )
                    );
                });
            }
        )
    };


    this.attachMiners = function (miners) {
        miners.forEach(function (clientObj) {
            _this.stratumServer.manuallyAddStratumClient(clientObj);
        });
        _this.stratumServer.broadcastMiningJobs(_this.jobManager.currentJob.getJobParams());

    };


    this.getStratumServer = function () {
        return _this.stratumServer;
    };


    this.setVarDiff = function (port, varDiffConfig) {
        if (typeof (_this.varDiff[port]) !== 'undefined') {
            _this.varDiff[port].removeAllListeners();
        }
        _this.varDiff[port] = new varDiff(port, varDiffConfig);
        _this.varDiff[port].on('newDifficulty', function (client, newDiff) {
            client.enqueueNextDifficulty(newDiff);
	    const jobPackedDiff = util.beamDiffPack(newDiff);

	    var job = _this.jobManager.currentJob;
	    job.rpcData.difficulty = jobPackedDiff; 
	    client.sendMiningJob(job);	
        });
    };

    this.getTotalMinerCount = function () {
        return _this.stratumServer.getTotalMinerCount();
    };

};
pool.prototype.__proto__ = events.EventEmitter.prototype;
