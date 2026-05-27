# AegisLink — Group Call Protocol (WebRTC Mesh)

## Overview

Group calls use a full-mesh topology: every participant establishes a direct
peer-to-peer RTCPeerConnection to every other participant. For N participants
there are N*(N-1)/2 connections. The relay is a blind forwarder — it never
stores or inspects SDPs or ICE candidates.

Media is encrypted end-to-end via DTLS-SRTP, which is mandatory in all
compliant WebRTC implementations. The relay has zero visibility into call
content.

---

## 1. Initiating a Group Call

**Caller (Device A):**

```
POST /calls/group/initiate
{
  "groupId": "<groupId>",
  "initiatorId": "<aegisId_A>",
  "media": "audio" | "video",
  "memberIds": ["<aegisId_B>", "<aegisId_C>", ...]
}
```

**Server response:**
```json
{ "callId": "<uuid>", "expiresAt": 1234567890000 }
```

**Server side effects:**
- Creates an in-memory room with `participants = { aegisId_A }`.
- Emits `group_call_invite` to all `memberIds` (except the initiator) via
  their Socket.IO room:
  ```json
  { "callId": "<uuid>", "groupId": "<groupId>", "media": "audio|video", "expiresAt": 1234567890000 }
  ```

---

## 2. Joining the Call

Each invited participant that accepts calls:

```
POST /calls/group/:callId/join
{ "aegisId": "<aegisId_B>" }
```

**Server response:**
```json
{ "participants": ["<aegisId_A>", "<aegisId_B>"] }
```

**Server side effects:**
- Adds `aegisId_B` to the room's participant set.
- Emits `group_call_joined` to all previously existing participants:
  ```json
  { "callId": "<uuid>", "aegisId": "<aegisId_B>" }
  ```

The joining device uses the returned `participants` list to know which
PeerConnections it must create (one per existing participant).

---

## 3. Mesh PeerConnections

When participant B joins and receives `{ participants: [A] }`:

- B creates one `RTCPeerConnection` towards A.
- B is the offerer for all connections it initiates upon joining.
- Existing participants (A) receive `group_call_joined` and create a
  PeerConnection as the answerer for the new peer.

**Convention:**
- The joining participant is always the **offerer**.
- Each existing participant is the **answerer** for the newly joined peer.

This avoids offer/answer collisions without needing perfect negotiation.

For N participants total: N*(N-1)/2 connections exist at steady state.

---

## 4. Offer / Answer / ICE Exchange (per pair)

All signaling goes through Socket.IO events on the authenticated relay connection.

### 4.1 Send Offer (B → A)

```javascript
socket.emit('group_offer', {
  callId: '<uuid>',
  toAegisId: '<aegisId_A>',
  sdp: rtcPeerConnection.localDescription.sdp
});
```

A receives:
```json
{ "callId": "<uuid>", "fromAegisId": "<aegisId_B>", "sdp": "..." }
```

### 4.2 Send Answer (A → B)

```javascript
socket.emit('group_answer', {
  callId: '<uuid>',
  toAegisId: '<aegisId_B>',
  sdp: rtcPeerConnection.localDescription.sdp
});
```

### 4.3 ICE Candidates (bidirectional)

```javascript
rtcPeerConnection.onicecandidate = (event) => {
  if (event.candidate) {
    socket.emit('group_ice', {
      callId: '<uuid>',
      toAegisId: '<remote_aegisId>',
      candidate: JSON.stringify(event.candidate)
    });
  }
};
```

Recipient receives:
```json
{ "callId": "<uuid>", "fromAegisId": "<sender_aegisId>", "candidate": "..." }
```

The receiving client must route each signaling message to the correct
PeerConnection by matching `fromAegisId` to the connection map.

---

## 5. Handling Disconnections and Departures

### Voluntary leave

```
POST /calls/group/:callId/leave
{ "aegisId": "<aegisId_X>" }
```

Remaining participants receive `group_call_left`:
```json
{ "callId": "<uuid>", "aegisId": "<aegisId_X>" }
```

Client must close and discard the RTCPeerConnection for `aegisId_X`.

### Unexpected disconnect

The relay does not proactively emit a leave event on socket disconnect.
Clients detect this via:
1. `RTCPeerConnection.onconnectionstatechange` → `"disconnected"` / `"failed"`
2. ICE failure after the standard ICE restart timeout.

On detection, the client should:
1. Close the affected PeerConnection.
2. Remove the peer from the local participants list.
3. Optionally call `POST /calls/group/:callId/leave` on behalf of the departed
   peer if it was the last one who can do so (optional — the room expires
   automatically after 2 hours).

### Room expiry

Rooms expire after 2 hours. `GET /calls/group/:callId` returns `404` after
expiry. Clients polling this endpoint can detect expiry and tear down all
PeerConnections.

---

## 6. Room State Endpoint

```
GET /calls/group/:callId
```

Response:
```json
{
  "callId": "<uuid>",
  "participants": ["<aegisId_A>", "<aegisId_B>"],
  "media": "audio",
  "expiresAt": 1234567890000
}
```

Use this to refresh the participant list when re-joining or after a reconnect.
