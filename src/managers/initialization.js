import { SocketManager } from "./sockets.manager.js";
import { SessionManager } from "./session.manager.js";
import { MessageManager } from "./message.manager.js";
import { StorageManager } from "./storage.manager.js";
import { ProtocolMapFactory } from "../protocols/map.js";
import { ThrottleManager } from "./throttle.manager.js";
import { ConnectionManager } from "./connection.manager.js";
import { MuxManager, FrameTypes } from "./multiplexer.manager.js";
import { SpaceFileListManager, SpaceFileManager } from "./file.manager.js";
import { FileContentDeliveryManager } from "./delivery.manager.js";

export function initializeManagers(emitter) {
    const sessionManager = new SessionManager();
    const socketManager = new SocketManager(emitter);
    const muxManager = new MuxManager(emitter);

    const storageManager = new StorageManager(emitter, {
        sessionManager
    });

    const spaceFileListManager = new SpaceFileListManager(emitter, {
        sessionManager,
    });

    const throttleManager = new ThrottleManager(emitter, {
        sessionManager,
        storageManager
    });

    const messageManager = new MessageManager(emitter, {
        socketManager,
        storageManager,
        sessionManager,
        throttleManager,
        muxManager,
        spaceFileListManager,
    });

    const connectionManager = new ConnectionManager(emitter, {
        sessionManager,
        socketManager,
        storageManager,
        messageManager,
        muxManager
    });

    const spaceFileManager = new SpaceFileManager(emitter, {
        sessionManager,
        socketManager,
        messageManager,
        connectionManager,
        spaceFileListManager
    });

    const fileContentDeliveryManager = new FileContentDeliveryManager(emitter, {
        sessionManager,
        messageManager,
        muxManager
    });

    muxManager.setHandlers([
        {
            type: FrameTypes.JSON,
            handler: (socket, data, info) => messageManager.handleIncomingMessage(socket, data, info)
        },
        {
            type: FrameTypes.STREAM,
            handler: (socket, data, info) => spaceFileManager.handleIncomingStream(socket, data, info)
        }
    ]);

    const protocols = ProtocolMapFactory(emitter, {
        socket: socketManager,
        storage: storageManager,
        session: sessionManager,
        message: messageManager,
        spaceFileList: spaceFileListManager,
        mux: muxManager,
        delivery: fileContentDeliveryManager
    });

    messageManager.setProtocolMap(protocols);

    return {
        session: sessionManager,
        sockets: socketManager,
        storage: storageManager,
        throttle: throttleManager,
        mux: muxManager,
        message: messageManager,
        connection: connectionManager,
        spaceFileList: spaceFileListManager,
        spaceFiles: spaceFileManager,
        delivery: fileContentDeliveryManager
    };
}