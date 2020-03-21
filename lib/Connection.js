/**
 * 
 * 
 * 
 * 
 * 
 */
const EventType = {
	DATA : "data"
};

const RequestType = {
	AUTHENTICATION : "authentication"
}

class Connection {
	
	constructor(config) {
		this.ip = config.ip;
		this.port = Number(config.port);
		this.username = config.username;
		this.password = config.password;
		this.ssl = config.ssl;
		this.coin = config.coin;
		this.log = config.logger;
		this.client = null;
		this.connected = false;
		this.authenticated = false;
		this.eventHandlers = new Map();
		this.currentPartialData = null;
	}
	
	connect(authenticateRequestParams = "", authenticateResponseMaping = {}) {
		throw new Error("Connect is not yet implemented");
	}
	
	disconnect() {
		throw new Error("Disconnect is not yet implemented");
	}
	
	send(data) {
		throw new Error("send is not yet implemented");
	}
	
	processData(data) {
		var eof = data.endsWith("\r\n");
		if(eof) {
			console.log("end with \\r\\n");
		}
		else if(data.endsWith("\n")) {
			console.log("end with \\n");
		} 
		var bulkData= data.split("\n");
		data = "";
		for (var i = 0; i < bulkData.length; i++) {
			if (bulkData[i].length === 0) continue;
			data += bulkData[i];
		}
		if(eof) {
			if(this.currentPartialData) {
				this.currentPartialData += data
				data = this.currentPartialData;
			}
			this.currentPartialData = null;
		} else {
			this.currentPartialData = data;
			return null;
		}
		return data;
	}
	
	onDataReceived(data) {
		console.log("bufferSize=%s,bytesRead=%s,bytesWritten=%s, dataSize=%s", this.client.bufferSize, this.client.bytesRead, this.client.bytesWritten, data.length);
		console.log("data + " + data);
		//var data = this.processData(data);
		if(!data) return;
		try {
			var parseJson = JSON.parse(data);
			//this.currentPartialData = null;
		} catch(error) {
			console.log("ERROR: " + error);
			console.log("data = " + data);
			this.currentPartialData = data;
			return;
		}
		const dataObj = parseJson;
		if(dataObj.command !== "MINING_JOB") {
			console.log("data data data data data %O", dataObj);
		}
		var dataHandlers = this.eventHandlers.get(EventType.DATA);
		if(dataHandlers) {
			dataHandlers.forEach(function(handler) {
				handler(dataObj);
			});
		}
		var dataKeys = Object.keys(dataObj);
		var handled = false;
		//console.log("handers %O", this.eventHandlers);
		for(var index in dataKeys) {
			const handlerKey = {};
			handlerKey[dataKeys[index]] = dataObj[dataKeys[index]];
			var eventKey = JSON.stringify(handlerKey);
			var objHandlers = this.eventHandlers.get(JSON.stringify(handlerKey));
			//console.log("handler %O=%O", handlerKey, objHandlers);
			if(objHandlers && objHandlers.length > 0) {
				handled = true;
				objHandlers.forEach(function(handler) {
					handler(dataObj, eventKey);
				});
				break;
			}
		}
		if(!handled) {
			console.log("not handled event *O", dataObj);
		}
		
	}
	
	on(event, handler) {
		if(event instanceof Object) {
			event = JSON.stringify(event);
		}
		if(!this.eventHandlers.get(event)) {
			this.eventHandlers.set(event,[]);
		}
		this.eventHandlers.get(event).push(handler);
	}
	
	getUsername() {
		return this.username;
	}
	
	getPassword() {
		return this.password;
	}
}

module.exports = Connection;
module.exports.EventType = EventType;
module.exports.RequestType = RequestType;
