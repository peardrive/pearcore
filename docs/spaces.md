# Spaces

A space is basically a room. Give it a name, decide who can post and who can read, and PearCore turns that into a discoverable topic that peers can find each other on without any server being involved. This process only requires [DHT discovery](./networking.md) to initiate the connection, and then peers will directly communicate for the rest of their presence.

Every space has 3 identity properties: `spaceName`, `nonce`, and `publicKey`. PearCore strictly controls `publicKey`, which is tied to [your account](./accounts.md), and `nonce`, which is a random string that avoids topic collisions.

The `publicKey` property is your account's identity on the network; it represents the owner of the space. Additionally, `nonce` allows a single owner to have multiple spaces with identical names coexist at the same time by assigning randomness to the topics. This means you can have two apps both called `CoolChatApp`, but they can be completely separated spaces.

Let's see the first example:
```javascript
import { createCore } from 'pearcore';

const username = 'username';
const password = 'password';

const core = await createCore();

// only create an account once
await core.accounts.create(username, password);

// every run requires authentication
await core.accounts.authenticate(username, password);

const space = await core.space.create({ spaceName: 'ChatApp' });

console.log(space.sharelink);
// pearcore://abcsomerandomtext
```

The combination of these 3 properties creates something called a space topic, which can be shared across users as "sharelinks."

A **sharelink** is an invite key to join any space in the network. It consists of a prefix and a token like this:
`pearcore://abcdfg...xyz`. The token is compressed text from the space topic, while the prefix is an optional part that describes your app. Later we will see how we can change this prefix for personal interest, like `twitter://` or `myApp://`.

<p align="center">
    <img src="./assets/sharelink_popup_from_peardrop.png">
    <p align="center">This screenshot from <a href="https://github.com/peardrive/peardrop-mobile">Peardrop</a> demonstrates <strong>sharelink</strong> in both text format and QR code for quick scan.</p>
</p>

If you own a sharelink, that means you can join the space topic, but that doesn't mean you can interact with the space, read messages, or post your data into it, because any interaction with the space requires permissions, which are controlled internally by each user individually. This basically means **leaking your sharelink doesn't leak your privacy if you set your space permissions**.

## Permissions
Permissions decide whether you actually get to interact with the peers from the space. There are two independent switches on every space that lock the general ability to **Read** or **Broadcast** into the space:

- `permissionBroadcast`: the term broadcast defines the ability of an individual peer to post, send, or add something into the space. This term can have a different meaning depending on the protocol. For instance, broadcasting in messaging means a peer can "send" messages, while the same attribute in file sharing means a peer can advertise themselves as a provider in the space.

- `permissionRead`: the term read defines the ability of an individual peer to read and receive messages (or data in general) in the space. In messaging, once a message has been broadcast, each peer will decide on routing the message based on the peers that have permission to "read" the message.

By default, both of these properties of a space are set to `true`, which means every space is fully open by default. Therefore, they have to be manually set for each application separately.

For instance, if you're designing an **Announcements Channel** where only the creator would be able to send messages while other members are only allowed to read messages, you should set `permissionBroadcast=false` (which doesn't affect the creator of the space, since the creator is the only peer who can bypass the permission) and set `permissionRead=true`, which allows everyone with the **sharelink** to read messages from the space.

Here is how we can set permissions during the creation of the space:

```javascript
const space = await core.space.create({
    permissionRead: true,
    permissionBroadcast: false,
});
```

Additionally, there is also the concept of **exclusivity**, which is defined by whitelists. Basically, `permissionBroadcast` and `permissionRead` are both general switches that turn on or off a set of features for all the peers within the space. But a **whitelist** is a list of `publicKeys` that can bypass the general permission rules.

Imagine that "Announcements Channel" we mentioned earlier. In that example, we considered the owner of the space to be the only peer able to broadcast messages, but what if we wanted to allow a few trusted admins, along with the creator, to be able to broadcast messages while the rest of the peers remain basic readers?

In this example, we can set a whitelist for admins in the broadcast permissions. This list is a basic `Array` of public keys, like this:
`broadcastWhitelist=[ "admin_1_publicKey", "admin_2_publicKey", ... ]`.

This same setting can be set for readers, like this:
`readWhitelist=[ "reader_1_publicKey", "reader_2_publicKey" ]`.

In summary, for our "Announcements Channel" we can secure the space by setting permissions like this:
```javascript
const listOfAdmins = ['pub1', 'pub2', 'pub3'];

const space = await core.space.create({
    permissionRead: true,
    permissionBroadcast: false,
    
    // setting exception for admins
    broadcastWhitelist: listOfAdmins,
    // readWhitelist: [] - this one is optional and empty by default
});
```

**That's it!** <br>
A space is the smallest unit of permission control, meaning any application at scale would utilize multiple spaces for complex permission control. For instance, you can have a "message space" just to control who can message, while within that system you want to limit the number of people who can share files in the chat, so the application would use a secondary space like a "file space" that controls the peers who can share files. **A complicated ChatApp could be a combination of multiple spaces working together.**

## Space Control
Let's walk through the code and see how we can work with spaces in PearCore.

### Create, Update, and Delete
If you already know how [account management works](./accounts.md), then working with spaces is already straightforward. The general space properties look like this:

```javascript
const space = await core.space.create({
    spaceName: 'some cool name',
    permissionRead: true, // or false
    permissionBroadcast: true, // or false
    readWhitelist: [],
    broadcastWhitelist: []
});
```

When you create a space, the information about the space is first recorded into the local database, and then the topic of the space is broadcast to all connected peers through the [`SpaceHashList` protocol](./networking.md). This basically tells all connected peers that you are subscribed to a new topic of interest, but they have no information about the details of your space, because **topic hashes** cannot be converted back to space information such as name, permissions, and other things. **This helps with privacy.**

The same process happens if you intend to update the permissions of an already created space. This process also updates all the peers inside the space with the new permissions, so the rules can be applied across the network.

Here is an example of this:
```javascript
const space = await core.space.create({ spaceName: 'coolApp' });

const updatedSpace = await core.space.update(space, { permissionBroadcast: false });
```

Additionally, you can manage all your spaces using the list API:
```javascript
const list = await core.space.list();

// If you want to only list spaces that you own,
// then you simply have to pass your publicKey
const publicKey = core.getPublicKey();
const mySpaces = await core.space.list({ publicKey: publicKey });
```

You can quit any space immediately by deleting the space record from PearCore:
```javascript
await core.space.delete(space);
```

This will immediately tell all connected nodes that you are no longer interested in that topic. Therefore, PearCore won't receive any message or data from that space anymore.

> Note:
>
> If you are the owner of the space, deleting the space only deletes it for **YOU**, and connected peers can carry the space long after your presence in the space.
>
> We are considering an optional protocol that would act like a kill switch, so that all peers would eventually be forced to quit the space. Contact us if you are interested in this feature.
