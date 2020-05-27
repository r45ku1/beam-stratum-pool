var BigNum = require('bignum');
var net = require('net');
var events = require('events');
var tls = require('tls');
var fs = require('fs');

var util = require('./util.js');
const u2 = require('util');
var TLSoptions;

var forkH1 = 0;
var forkH2 = 0;

var SubscriptionCounter = function (poolId) {
    var count = 0;

    var padding = 'deadbeefcafebabe'
    padding = padding.substring(0, padding.length - poolId.length) + poolId

    return {
        next: function () {
            count++;
            if (Number.MAX_VALUE === count) count = 0;
            return padding + util.packInt64LE(count).toString('hex');
        }
    };
};


/**
 * Defining each client that connects to the stratum server.
 * Emits:
 *  - subscription(obj, cback(error, extraNonce1, extraNonce2Size))
 *  - submit(data(name, jobID, extraNonce2, ntime, nonce))
 **/
var StratumClient = function (options) {
    var userSetDifficulty = null;
    var previousDifficulty = null;

    //private members
    this.socket = options.socket;
    this.remoteAddress = options.socket.remoteAddress;
    var banning = options.banning;
    var _this = this;
    this.lastActivity = Date.now();
    this.shares = {
        valid: 0,
        invalid: 0
    };


    var considerBan = (!banning || !banning.enabled) ? function () {
        return false
    } : function (shareValid) {
        if (shareValid === true) _this.shares.valid++;
        else _this.shares.invalid++;
        var totalShares = _this.shares.valid + _this.shares.invalid;
        if (totalShares >= banning.checkThreshold) {
            var percentBad = (_this.shares.invalid / totalShares) * 100;
            if (percentBad < banning.invalidPercent) //reset shares
                this.shares = {
                    valid: 0,
                    invalid: 0
                };
            else {
                _this.emit('triggerBan', _this.shares.invalid + ' out of the last ' + totalShares + ' shares were invalid');
                _this.socket.destroy();
                return true;
            }
        }
        return false;
    };

    this.init = function init() {
        setupSocket();
    };

    function handleMessage(message) {
        switch (message.method) {
            //case 'mining.subscribe':
           //     handleSubscribe(message);
           //     break;
            case 'login':
                handleAuthorize(message, true);
                break;
            case 'solution':
                _this.lastActivity = Date.now();
                handleSubmit(message);
                break;
            default:
                _this.emit('unknownStratumMethod', message);
                break;
        }
    }

    function handleSubscribe(message) {
        if (!_this.authorized) {
            _this.requestedSubscriptionBeforeAuth = true;
        }
        _this.minerVersion = message.params[0];
        _this.emit('subscription', {},
            function (error, extraNonce1, extraNonce1) {
                if (error) {
                    sendJson({
                        id: message.id,
                        result: null,
                        error
                    });
                    return;
                }
                _this.extraNonce1 = extraNonce1;

                sendJson({
                    id: message.id,
                    result: [
                        null, //sessionId
                        extraNonce1
                    ],
                    error: null
                });
            });
    }

    function getSafeString(s) {
        return s.toString().replace(/[^a-zA-Z0-9.]+/g, '');
    }

    function getSafeWorkerString(raw) {
        var s = getSafeString(raw).split(".");
        var addr = s[0];
        var wname = "noname";
        if (s.length > 1)
            wname = s[1];
        return addr + "." + wname;
    }

    /*
      { method: 'login',
      api_key: 'some_miner_key',
      id: 'login',
      jsonrpc: '2.0' }
    */
    function handleAuthorize(message, replyToSocket) {
//	    console.log("message=" + JSON.stringify(message));
        const api_key = JSON.stringify(message['api_key']);
	const agent = message['agent'];
        _this.workerName = getSafeWorkerString(api_key);
        _this.workerPass = "todo"; // message.params[1];

        //console.log(`api_key=${api_key} _this.workerName=${_this.workerName} message:${JSON.stringify(message)}`);
        var addr = _this.workerName.toString().split(".")[0];
        options.authorizeFn(_this.remoteAddress, options.socket.localPort, _this.workerName, function (result) {
            _this.authorized = (!result.error && result.authorized);       

            if (_this.authorized) {
                const nonceprefix = options.counter.next();
                sendJson({
                    code: 0,
                    description: "Login Successful",
                    id: message.id,
                    jsonrpc: "2.0",
                    nonceprefix: nonceprefix,
                    forkheight: forkH1,
                    forkheight2: forkH2,
                    method: "result"
                });
            } else {
                sendJson({
                    code: -32003,
                    description: `Login Failed: ${result.error}`,
                    id: message.id,
                    jsonrpc: "2.0",
                    method: "result"
                });
            }

            // If the authorizer wants us to close the socket lets do it.
            if (result.disconnect === true) {
                options.socket.destroy();
            }


            _this.poolWorkerId = result.poolWorkerId;
            if (agent && agent.indexOf('NiceHash') > -1)
	        _this.userSetDifficulty = 32768;
	    else
            	_this.userSetDifficulty = result.userSetDifficulty;

            _this.poolUserId = result.poolUserId;
            _this.poolCoinId = result.poolCoinId;

            _this.emit('authorized', result);

        });
    }
    /**
     share submitted:  someminerkey.noname {"method":"solution","id":"1864","nonce":"17d1b85110356d08","output":"00993e0baa853a3afbeeb8b0b500a2636bfb4982904e82e4e301325ac2509086dbc7395f1b32a191d13033b0d6bba1f9fbb7134e0568f72c52384b96dc73fc4bce171c0085da5ed5a3ebe3c4365f0bc195fe6770a2c1b4223d355f737d40f9bd7e6925bc431d5346","jsonrpc":"2.0"}
     */
    function handleSubmit(message) {
        // console.log('share submitted: ', _this.workerName, JSON.stringify(message))

        if (!_this.workerName) {
            // _this.workerName = getSafeWorkerString(message.params[0]);
        }
        if (_this.authorized === false) {
            console.log('!!! not authorized')
            sendJson({
                code: -32003,
                descriptin: "Login First",
                id: "login",
                /*message.id,*/
                jsonrpc: "2.0",
                methood: "result"
            });
            considerBan(false);
            return;
        }
        /* TODO USE nonce  prefix here?
        if (!_this.extraNonce1){
            //console.log("not subscribed")
            sendJson({
                id    : message.id,
                result: null,
                error : [25, "not subscribed", null]
            });
            considerBan(false);
            return;
        }

	*/
        //console.log("mnessage.id=" +  message.id  +  " message.nonce=" +message.nonce + " message.output=" + message.output);
        _this.emit('submit',
            {
                name: _this.workerName,//message.params[0],
                id: message.id,
                nonce: message.nonce,
                output: message.output,
                jsonrpc: "2.0",
            },
            // lie to Claymore miner due to unauthorized devfee submissions
            function (error, result) {
                if (error) {
		//	console.log("error=" + JSON.stringify(error) + " result=" + result);
			const errJson = { 
				code: -32003,
				description: error,
				id: message.id,
				jsonrpc: "2.0",
				method: "result"
			};
			console.log("sending error: " + JSON.stringify(errJson));
                    sendJson(errJson);
                }
            }
        );

	const submitJson = {
		code: 1,
		description: "accepted",
		id: message.id,
		jsonrpc: "2.0",
		method: "result"
	};
	sendJson(submitJson);	
    }

    function sendJson() {
        var response = '';
        for (var i = 0; i < arguments.length; i++) {
            response += JSON.stringify(arguments[i]) + '\n';
        }
        options.socket.write(response);
    }

    function setupSocket() {
        var socket = options.socket;
        var dataBuffer = '';
        socket.setEncoding('utf8');

        if (options.tcpProxyProtocol === true) {
            socket.once('data', function (d) {
                if (d.indexOf('PROXY') === 0) {
                    _this.remoteAddress = d.split(' ')[2];
                } else {
                    _this.emit('tcpProxyError', d);
                }
                _this.emit('checkBan');
            });
        } else {
            _this.emit('checkBan');
        }
        socket.on('data', function (d) {
            dataBuffer += d;
            if (new Buffer.byteLength(dataBuffer, 'utf8') > 10240) { //10KB
                dataBuffer = '';
                _this.emit('socketFlooded');
                socket.destroy();
                return;
            }
            if (dataBuffer.indexOf('\n') !== -1) {
                var messages = dataBuffer.split('\n');
                var incomplete = dataBuffer.slice(-1) === '\n' ? '' : messages.pop();
                messages.forEach(function (message) {
                    if (message.length < 1) return;
                    var messageJson;
                    try {
                        messageJson = JSON.parse(message);
                    } catch (e) {
                        if (options.tcpProxyProtocol !== true || d.indexOf('PROXY') !== 0) {
                            _this.emit('malformedMessage', message);
                            socket.destroy();
                        }

                        return;
                    }
                    if (messageJson) {
                        handleMessage(messageJson);
                    }
                });
                dataBuffer = incomplete;
            }
        });
        socket.on('close', function () {
            _this.emit('socketDisconnect', _this.poolWorkerId);
        });
        socket.on('error', function (err) {
            if (err.code !== 'ECONNRESET')
                _this.emit('socketError', err);
        });
    }


    this.getLabel = function () {
        return (_this.workerName || '(unauthorized)') + ' [' + _this.remoteAddress + ']';
    };

    // This will be sent as job diff json to miners
    this.enqueueNextDifficulty = function (requestedNewDifficulty) {
	requestedNewDifficulty = requestedNewDifficulty.toFixed(0);
	this.previousDifficulty = this.userSetDifficulty;
        this.userSetDifficulty = requestedNewDifficulty;

        //const jobPackedDiff = util.beamDiffPack(requestedNewDifficulty);
	//jobParams.rpcData.difficulty = jobPackedDiff;
	return true;
    };



    /*
      jobParams=BlockTemplate {
      rpcData:
       { difficulty: 147711404,
         input: 'ccada092b02d1659ed11deedc29e8d38ffead25c2ca592c16fea90f920b291aa',
         jobid: '110',
         height: 349046 },
      jobId: 'cccd',
      registerSubmit: [Function] }
    */
    this.sendMiningJob = function (jobParams) {
        //console.log("sendMiningJob=" + JSON.stringify(jobParams));
        var lastActivityAgo = Date.now() - _this.lastActivity;
        if (lastActivityAgo > options.connectionTimeout * 1000) {
            _this.socket.destroy();
            return;
        }


        // TODO  PACK/UNPACK

        //	console.log("sendMiningJob. jobParams=" + u2.inspect(jobParams));
        const jobBlockDiff = jobParams.rpcData.difficulty;
        const jobPackedDiff = util.beamDiffPack(_this.userSetDifficulty);

        //console.log(`sendMiningJob usertSetDifficulty: ${_this.userSetDifficulty} Packed: ${jobPackedDiff}`);


        let jobData = {
            difficulty: jobPackedDiff, // unpacked
            id: jobParams.rpcData.id,
            input: jobParams.rpcData.input,
            height: jobParams.rpcData.height,
            jsonrpc: "2.0",
            method: "job"
        }
        // console.log(`miner jobActualDiff: ${ jobData.difficulty }(Packed: ${ jobPackedDiff } Unpacked: ${ _this.userSetDifficulty }) blockDiff: ${ jobBlockDiff }`);
        sendJson(jobData);
        _this.emit('difficultyChanged', _this.userSetDifficulty);
    };
};
StratumClient.prototype.__proto__ = events.EventEmitter.prototype;




/**
 * The actual stratum server.
 * It emits the following Events:
 *   - 'client.connected'(StratumClientInstance) - when a new miner connects
 *   - 'client.disconnected'(StratumClientInstance) - when a miner disconnects. Be aware that the socket cannot be used anymore.
 *   - 'started' - when the server is up and running
 **/
var StratumServer = exports.Server = function StratumServer(options, authorizeFn) {

    //ports, connectionTimeout, jobRebroadcastTimeout, banning, haproxy, authorizeFn

    var bannedMS = options.banning ? options.banning.time * 1000 : null;

    var _this = this;
    var stratumClients = {};
    var subscriptionCounter = SubscriptionCounter(options.poolId || '');
    var rebroadcastTimeout;
    var bannedIPs = {};
    
    this.setForks = function (fork1, fork2) {
    	forkH1 = fork1;
    	forkH2 = fork2;
    }


    function checkBan(client) {
        if (options.banning && options.banning.enabled) {
            if (options.banning.banned && options.banning.banned.includes(client.remoteAddress)) {
                client.socket.destroy();
                client.emit('kickedBannedIP', 9999999);
                return
            }

            if (client.remoteAddress in bannedIPs) {
                var bannedTime = bannedIPs[client.remoteAddress];
                var bannedTimeAgo = Date.now() - bannedTime;
                var timeLeft = bannedMS - bannedTimeAgo;
                if (timeLeft > 0) {
                    client.socket.destroy();
                    client.emit('kickedBannedIP', timeLeft / 1000 | 0);
                } else {
                    delete bannedIPs[client.remoteAddress];
                    client.emit('forgaveBannedIP');
                }
            }
        }
    }

    this.handleNewClient = function (socket) {

        socket.setKeepAlive(true);
        var subscriptionId = subscriptionCounter.next();
        var client = new StratumClient({
            subscriptionId: subscriptionId,
            authorizeFn: authorizeFn, //FIXME
            socket: socket,
            banning: options.banning,
            connectionTimeout: options.connectionTimeout,
            tcpProxyProtocol: options.tcpProxyProtocol,
            counter: options.counter,
        });

        client.userSetDifficulty = options.ports[socket.localPort].diff;

        stratumClients[subscriptionId] = client;
        _this.emit('client.connected', client);
        client.on('socketDisconnect', function () {
            _this.removeStratumClientBySubId(subscriptionId);
            _this.emit('client.disconnected', client);
        }).on('checkBan', function () {
            checkBan(client);
        }).on('triggerBan', function () {
            _this.addBannedIP(client.remoteAddress);
        }).init();
        return subscriptionId;
    };


    this.broadcastMiningJobs = function (jobParams) {
        //console.log("stratum broadcastMiningJobs params=" + JSON.stringify(jobParams));

        for (var clientId in stratumClients) {
            var client = stratumClients[clientId];
            client.sendMiningJob(jobParams);
        }
        /* Some miners will consider the pool dead if it doesn't receive a job for around a minute.
           So every time we broadcast jobs, set a timeout to rebroadcast in X seconds unless cleared. */
        clearTimeout(rebroadcastTimeout);
        rebroadcastTimeout = setTimeout(function () {
            _this.emit('broadcastTimeout');
        }, options.jobRebroadcastTimeout * 1000);
    };



    (function init() {

        //Interval to look through bannedIPs for old bans and remove them in order to prevent a memory leak
        if (options.banning && options.banning.enabled) {
            setInterval(function () {
                for (ip in bannedIPs) {
                    var banTime = bannedIPs[ip];
                    if (Date.now() - banTime > options.banning.time)
                        delete bannedIPs[ip];
                }
            }, 1000 * options.banning.purgeInterval);
        }


        //SetupBroadcasting();

        if ((typeof (options.tlsOptions) !== 'undefined' && typeof (options.tlsOptions.enabled) !== 'undefined') && (options.tlsOptions.enabled === "true" || options.tlsOptions.enabled === true)) {

            TLSoptions = {
                key: fs.readFileSync(options.tlsOptions.serverKey),
                cert: fs.readFileSync(options.tlsOptions.serverCert),
                requireCert: true
            }
        }

        var serversStarted = 0;
        for (var port in options.ports) {
            if (options.ports[port].tls === false || options.ports[port].tls === "false") {
                net.createServer({
                    allowHalfOpen: false
                }, function (socket) {
                    _this.handleNewClient(socket);
                }).listen(parseInt(port), function () {
                    serversStarted++;
                    if (serversStarted == Object.keys(options.ports).length)
                        _this.emit('started');
                });
            } else {
                // console.log("Create TLS Server");
                tls.createServer(TLSoptions, function (socket) {
                    _this.handleNewClient(socket);
                }).listen(parseInt(port), function () {
                    serversStarted++;
                    if (serversStarted == Object.keys(options.ports).length)
                        _this.emit('started');
                });
            }
        }
    })();


    //public members

    this.addBannedIP = function (ipAddress) {
        bannedIPs[ipAddress] = Date.now();
        /*for (var c in stratumClients){
            var client = stratumClients[c];
            if (client.remoteAddress === ipAddress){
                _this.emit('bootedBannedWorker');
            }
        }*/
    };

    this.getStratumClients = function () {
        return stratumClients;
    };

    this.removeStratumClientBySubId = function (subscriptionId) {
        delete stratumClients[subscriptionId];
    };

    this.manuallyAddStratumClient = function (clientObj) {
        var subId = _this.handleNewClient(clientObj.socket);
        if (subId != null) { // not banned!
            stratumClients[subId].manuallyAuthClient(clientObj.workerName, clientObj.workerPass);
            stratumClients[subId].manuallySetValues(clientObj);
        }
    };

    this.getTotalMinerCount = function () {
        return Object.keys(stratumClients).length;
    }

};
StratumServer.prototype.__proto__ = events.EventEmitter.prototype;
