var events = require('events');
var crypto = require('crypto');
var bignum = require('bignum');
var blake2b = require('blake2b')

var util = require('./util.js');
var blockTemplate = require('./blockTemplate.js');
let u2 = require('util');
const eh = require('equihashverify');



// todo change this to support noncePrefix?
//Unique extranonce per subscriber
var ExtraNonceCounter = function (configInstanceId) {
    var instanceId = configInstanceId || crypto.randomBytes(4).readUInt32LE(0);
    var counter = instanceId << 27;
    this.next = function () {
        var extraNonce = util.packUInt32BE(Math.abs(counter++));
        return extraNonce.toString('hex');
    };
    this.size = 3; //bytes
};

//Unique job per new block template
var JobCounter = function () {
    var counter = 0x0000cccc;

    this.next = function () {
        counter++;
        if (counter % 0xffffffffff === 0)
            counter = 1;
        return this.cur();
    };

    this.cur = function () {
        return counter.toString(16);
    };
};

function isHexString(s) {
    var check = String(s).toLowerCase();
    if (check.length % 2) {
        return false;
    }
    for (i = 0; i < check.length; i = i + 2) {
        var c = check[i] + check[i + 1];
        if (!isHex(c))
            return false;
    }
    return true;
}

function isHex(c) {
    var a = parseInt(c, 16);
    var b = a.toString(16).toLowerCase();
    if (b.length % 2) {
        b = '0' + b;
    }
    if (b !== c) {
        return false;
    }
    return true;
}

/**
 * Emits:
 * - newBlock(blockTemplate) - When a new block (previously unknown to the JobManager) is added, use this event to broadcast new jobs
 * - share(shareData, blockHex) - When a worker submits a share. It will have blockHex if a block was found
 **/
var JobManager = module.exports = function JobManager(options) {

    var _this = this;
    //var jobCounter = new JobCounter();

    //var shareMultiplier = algos[options.coin.algorithm].multiplier;

    //public members

    this.extraNonceCounter = new ExtraNonceCounter(options.instanceId);

    this.currentJob = null;
    this.validJobs = {};

    var hashDigest = algos[options.coin.algorithm].hash(options.coin);

    this.updateCurrentJob = function (rpcData) {

        emitWarningLog("updateCurrentJob: " + u2.inspect(rpcData));

        var tmpBlockTemplate = new blockTemplate(
            rpcData,
            _this.extraNoncePlaceholder,
        );

        _this.currentJob = tmpBlockTemplate;
        _this.emit('updatedBlock', tmpBlockTemplate, true);
        _this.validJobs[tmpBlockTemplate.id] = tmpBlockTemplate;

    };

    //returns true if processed a new block
    this.processTemplate = function (rpcData) {
        // Block is new if A) its the first block we have seen so far or B) the blockhash is different and the
        // block height is greater than the one we have
        var isNewBlock = !_this.currentJob;

        if (_this.currentJob && _this.currentJob.rpcData.height !== rpcData.height) {
            isNewBlock = true;

            //If new block is outdated/out-of-sync than return
            if (rpcData.height < _this.currentJob.rpcData.height) {
                console.log("*** OUTDATED BLOCK");
                return false;
            }
        }
        // console.log("isNewBlock=" + isNewBlock);

        if (!isNewBlock) {
            return false;
        }

        var tmpBlockTemplate = new blockTemplate(
            rpcData,
            options.coin
        );


        this.currentJob = tmpBlockTemplate;

        this.validJobs = {};
        _this.emit('newBlock', tmpBlockTemplate);
        this.validJobs[tmpBlockTemplate.id] = tmpBlockTemplate;

        return true;
    };

    this.processShare = function (id, previousDifficulty, difficulty, extraNonce1, extraNonce2, nonce, ipAddress, port, workerName, output, poolWorkerId, poolUserId, poolCoinId) {
	    var shareError = function (error) {
	      _this.emit('share', {  
		id: id,
		code: -32003,
                description: error[1],
                jsonrpc: "2.0",
                method: "result",
	        error: error[1]
	      });

            return {error: error[1], result: null};
        };

        // console.log(`processShare: id:${id} previousDifficulty:${previousDifficulty} difficulty:${difficulty} nonce:${nonce} ip:${ipAddress} port:${port} workerName:${workerName} output:${output}`)

        var submitTime = Date.now() / 1000 | 0;

        const job = this.validJobs[id];

        if (typeof job === 'undefined' || job.rpcData.id != id) {
            return shareError([-32008, 'job not found']);
        }
	
	if (this.currentJob.rpcData.height != job.rpcData.height) {
            return shareError([-32008, 'job not found.']);
	}
        const input = job.rpcData.input;

        if (nonce.length !== 16) {
            // console.log('incorrect size of nonce');
            return shareError([-32007, 'incorrect size of nonce']);
        }

        let expectedLength = 208;
        let solutionSlice = 0;

        if (output.length !== expectedLength) {
            return shareError([-32004, 'Error: Incorrect size of solution (' + output.length + '), expected ' + expectedLength]);
        }


        if (!job.registerSubmit(nonce, output)) {
            return shareError([-32006, 'duplicate share']);
        }

        // check if valid solution
        let inputBuf = Buffer.from(input, 'hex');
        let outputBuf = Buffer.from(output, 'hex');
        let nonceBuf = Buffer.from(nonce, 'hex');

        const isValid = eh.verify(inputBuf, nonceBuf, outputBuf, 150, 5, 3);
        let headerHash = util.sha256(outputBuf);
        let bigNum = bignum.fromBuffer(headerHash, {
            endian: 'big',
            size: 32
        });

        const beamMaxDiff = 0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff;
        let shareDiff = parseFloat((beamMaxDiff / bigNum.toNumber()).toFixed(9));
        const blockDiff = job.rpcData.difficulty;

        //console.log("EHValid: " + isValid + " sharediff:" + shareDiff + " packed diff: " + util.beamDiffPack(shareDiff) + " blockDiff: " + blockDiff/* + " headerHash:" + headerHash.toString('hex')*/);

        let blockHex = null;

	if (shareDiff < difficulty) {
                if (!previousDifficulty || (previousDifficulty && (shareDiff < previousDifficulty))) 
                        return shareError([-32009, 'Low Difficulty Share']);
        }

        if (!isValid) {
            return shareError([-32008, 'Invalid Share']);
        }

        if (shareDiff >= blockDiff) {
            blockHex = headerHash;
        }

	const miningReward = util.getMiningReward(job.rpcData.height);

        _this.emit('share', {
            id: job.rpcData.id,
            ip: ipAddress,
	        nonce: nonce,
            port: port,
            worker: workerName,
            height: job.rpcData.height,
            blockReward: miningReward,
            difficulty: difficulty,
            shareDiff: shareDiff.toFixed(8),
	        output: output,
            blockDiff: blockDiff,
            blockDiffActual: job.difficulty,
            blockHash: null,
            blockHashInvalid: null,
            poolWorkerId: poolWorkerId,
            poolUserId: poolUserId,
            poolCoinId: poolCoinId
        }, blockHex);

        return {
            result: true,
            error: null,
    	    blockHash: null
        };
    };
};
JobManager.prototype.__proto__ = events.EventEmitter.prototype;
