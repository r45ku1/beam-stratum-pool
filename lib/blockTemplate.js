var bignum = require('bignum');

var merkle = require('./merkleTree.js');
var transactions = require('./transactions.js');
var util = require('./util.js');

/**
 * The BlockTemplate class holds a single job.
 * and provides several methods to validate and submit it to the daemon coin
**/
var BlockTemplate = module.exports = function BlockTemplate(
    rpcData,
    coin
) {
    //private members
    var submits = [];

    //public members
    this.rpcData = rpcData;
    this.id = rpcData['id'];

    // get target info
    
    //this.target = bignum(rpcData.target, 16);
    // this.difficulty = parseFloat((diff1 / this.target.toNumber()).toFixed(9));

    // generate the fees and coinbase tx

    // submit the block header
    this.registerSubmit = function(header, soln){
        var submission = (header + soln).toLowerCase();
        if (submits.indexOf(submission) === -1){

            submits.push(submission);
            return true;
        }
        return false;
    };
};
