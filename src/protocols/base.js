import { FrameTypes } from '../managers/multiplexer.manager.js';


export class BaseProtocolHandler {
    constructor(emitter, managers) {
        this.storageManager = managers.storage;
        this.sessionManager = managers.session;
        this.socketManager = managers.socket;
        this.messageManager = managers.message;
        this.spaceFileListManager = managers.spaceFileList;
        this.spaceFileManager = managers.spaceFiles;
        this.deliveryManager = managers.delivery;
        this.muxManager = managers.mux;

        this.emitter = emitter;
        this.emit = (event, callback) => this.emitter.emit(event, callback);
    }

    get credentials() {
        return this.sessionManager.getCredentials();
    }

    get db() {
        return this.sessionManager.getDatabase().db;
    }

    async sendStreamToSocket(stream, socket) {
        await this.muxManager.send(socket, stream, FrameTypes.STREAM);
    }

    async handle(socket, message, info) {
        throw new Error("Handle method must be implemented by subclass");
    }
}