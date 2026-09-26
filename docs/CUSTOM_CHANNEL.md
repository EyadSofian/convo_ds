# Custom Channel API

A Custom Channel connects a system the operator runs — a CRM, a website backend, a bot — to the inbox. Messages arrive signed, and agents' replies go back signed with the same key.

## Connecting

Channels → Custom API Channel → Connect, with:

- **Channel ID** — any stable id of your choosing (`A-Z a-z 0-9 . : _ -`, up to 128). It is part of the URL you post to.
- **Signing key** — a secret of 8 or more characters. Both directions are signed with it; it is stored encrypted and never shown again.
- **Reply URL** — a public `https://` address on your own domain where Convo posts replies. IP addresses and internal names are refused. It can be added or changed later from the connection's *Connect your system* panel.
- **Allowed browser origins** — optional. Your server posts without an `Origin` header and needs none. Only a web page posting to Convo directly needs its origin listed; a delivery that carries an `Origin` must match the list.

## Sending a customer's message to Convo

`POST {your Convo address}/api/v1/webhooks/custom/{channel id}`

```
content-type: application/json
x-convo-timestamp: <unix seconds>
x-convo-signature: v1=<hex HMAC-SHA256(signing key, timestamp + "." + raw body)>
```

```json
{
  "object": "convo_custom",
  "version": "1",
  "asset_id": "gateway-1",
  "events": [
    { "id": "msg-1001", "from": "customer-42", "type": "message", "text": "Hello", "name": "Mona Adel" }
  ]
}
```

- `from` is the customer's id in your system; it becomes their identity on this channel.
- `name` (or `sender.name`) names a new contact. It replaces the bare id once and never overwrites a name somebody gave the contact.
- `delivery_status` and `read_status` events with a `message_id` report on replies Convo sent you.
- Timestamps older than five minutes are refused, and a repeated event `id` is stored once.

The first signed delivery proves the key: the channel shows as connected once one has arrived.

## Receiving replies

Convo posts each reply to the Reply URL, signed the same way:

```json
{
  "object": "convo_custom",
  "version": "1",
  "asset_id": "gateway-1",
  "messages": [{ "id": "<attempt id>", "to": "customer-42", "type": "text", "text": "Hi Mona, how can we help?" }]
}
```

Answer `2xx` to accept it; `{"message_id": "..."}` in the body names the id later status events refer to (the attempt `id` is used otherwise). `429` and `5xx` are retried; `401`/`403` are retried after the key is fixed; any other `4xx` is a final refusal. A request that times out is marked *outcome unknown* and is not retried automatically, because your system may already have shown it to the customer.

**Verify connection** posts a signed `{"type": "ping"}` to the Reply URL and expects `2xx`.
