/**
 * 
 * 
 * 
 * 
 * 
 */
const net = require('net');
const Connection = require('./Connection.js');

class TCPConnection extends Connection {
	
	constructor(config) {
		super(config);
		
	}
	
	connect(authenticateRequestParams = null, authenticateResponseMaping = {}) {
		var self = this;
		this.authenticateRequestParams = authenticateRequestParams;
		if(!this.client) {
			this.client = new net.Socket();
			this.client.setEncoding("utf8");
			this.client.on(Connection.EventType.DATA, function(data) {
				this.onDataReceived(data);
			}.bind(this));
		}
		
		return new Promise(function(resolve, reject) {
			if(!self.client.destroyed) {
				if(!self.client.connecting) {
					self.clientConnect(authenticateRequestParams, resolve, reject);
				} else {
					resolve(true);
				}
			} else {
				self.clientConnect(authenticateRequestParams, resolve, reject);
			}
		});
	}
	
	onError(error) {
		console.log("ERROR:--------- %O", error)
	}
	
	
	
	clientConnect(authenticateRequestParams, resolve, reject) {
		try {
			if(this.authenticated) {
				return resolve(true);
			}
			var self = this;
			this.authenticatePromise = {
					resolve : resolve,
					reject : reject
			}
			this.client.connect(this.port, this.ip, function() {
				//console.log(`${self.ip}:${self.port} connected`);
				console.log(`${self.ip}:${self.port} connected`);
//				self.send(authenticateRequestParams).then(isSent => {
//					if(isSent) {
//						console.log(authenticateRequestParams + " is Successfully sent. pending for authenticated responsed");
//					} else {
//						reject("ERROR: can't authenticated");
//						this.authenticatePromise = null;
//					}
//					 
//				}).catch(reject);
				//self.onDataReceived.call(this)
//				self.client.on(Connection.EventType.DATA, function(data) {
//					self.onDataReceived(data);
//				});
//				self.client.on("error", (err) => {
//					console.log("ERROR: %O", err);
//				});
//				resolve(true);
			});
		} catch(error) {
			reject(error);
		}
	}
	
	send(data) {
		var self = this;
		return new Promise(function(resolve, reject) {
//			self.client.on(Connection.EventType.DATA, function(data) {
//				self.onDataReceived(data);
//			});
//			self.client.resume();
			if(data instanceof Object) {
				data = JSON.stringify(data);
			}
			resolve(self.client.write(data + "\r\n", function(res) {
				console.log("res %O",res)
			}));
//			self.connect().then(isConnected => {
//				if(isConnected) {
//					resolve(self.client.write(data));
//				} else {
//					console.log(`${connection.ip}:${port} is not connected`);
//					reject(`${connection.ip}:${port} is not connected`);
//				}
//			}). catch(reject);
		});
	}
	
	disconnect() {
		console.log("DISCONNECT() FROM TCPConnection");
		if(!this.client.destroyed && !this.client.connecting) {
			this.client.destroy();
			this.connected = false;
			this.authenticated = false;
			return true;
		}
		return false;
	}

}

module.exports = TCPConnection;
module.exports.EventType = Connection.EventType;
