# Voice Agent Setup Checklist

This repo is still in planning stage, so this checklist is the external setup you need before the runtime can be wired up.

## 1. Fill the environment file

Use [`.env`](/Users/sachin/Developer/My_Projects/voiceAgent/.env) for your real local values and keep [`.env.example`](/Users/sachin/Developer/My_Projects/voiceAgent/.env.example) as the template.

Required values:

- `TWILIO_ACCOUNT_SID`
- `TWILIO_AUTH_TOKEN`
- `TWILIO_PHONE_NUMBER`
- `DEFAULT_TARGET_NUMBER`
- `DEEPGRAM_API_KEY`
- `GROQ_API_KEY`
- `CARTESIA_API_KEY`
- `CARTESIA_VOICE_ID`
- `PUBLIC_BASE_URL`
- `PUBLIC_WS_BASE_URL`

## 2. Twilio setup

1. Create a Twilio account and open the Console dashboard.
2. Copy your Account SID and Auth Token into [`.env`](/Users/sachin/Developer/My_Projects/voiceAgent/.env).
3. Buy or claim a Twilio phone number with Voice capability.
4. If you are still on a Twilio trial, verify your personal phone number as a Verified Caller ID before testing outbound calls.
5. Put the Twilio number into `TWILIO_PHONE_NUMBER`.
6. Put your own test phone number into `DEFAULT_TARGET_NUMBER`.
7. Keep all phone numbers in E.164 format, for example `+14155551234`.

Important Twilio constraints for this project:

- Trial accounts can place outbound calls only to validated phone numbers.
- Trial accounts are limited to one Twilio phone number and trial calls are capped at 10 minutes.
- Twilio bidirectional Media Streams use `<Connect><Stream>` and your media websocket must be reachable over `wss://`.
- Bidirectional Media Streams do not support sending outbound DTMF from your websocket server, so keypad navigation should use Twilio call updates or `SendDigits`, which matches the current plan.

## 3. WDO / public endpoint setup

Assumption: "WDO" is the environment where you want the app reachable by Twilio. The exact same env values from [`.env`](/Users/sachin/Developer/My_Projects/voiceAgent/.env) need to exist there too.

1. Decide whether you are testing locally with a tunnel or deploying to a hosted environment first.
2. Expose a public HTTPS base URL for normal webhooks.
3. Expose a public WSS URL for the Twilio media stream websocket.
4. Set `PUBLIC_BASE_URL` to the HTTPS origin, for example `https://your-app.example.com`.
5. Set `PUBLIC_WS_BASE_URL` to the websocket origin, for example `wss://your-app.example.com`.
6. Make sure the runtime can serve both an HTTP TwiML route and a websocket media route.
7. If you are testing locally, use a tunnel that supports both HTTPS and websockets.

Minimum routes you will need once code is scaffolded:

- `POST /api/calls`
- `GET /api/calls/:call_id`
- A TwiML route that Twilio hits when the outbound call connects
- A websocket route that Twilio connects to for the media stream

## 4. Other accounts you still need

1. Deepgram account and API key for realtime speech-to-text.
2. Groq account and API key for structured action generation.
3. Cartesia account, API key, and one chosen voice ID for telephony output.
4. A private GitHub repository for the implementation work.

## 5. Missing project setup after accounts are ready

1. Bootstrap the Node.js + TypeScript app structure from the plan.
2. Add startup env validation so missing keys fail fast.
3. Create the HTTP server, websocket server, and Twilio call bootstrap route.
4. Add a local tunnel or hosted deployment target for iterative testing.
5. Rotate any real credentials that may have been pasted into notes or shared outside env files.

## 6. Official references

- Twilio outbound calls: https://www.twilio.com/docs/voice/tutorials/how-to-make-outbound-phone-calls
- Twilio free trial limits: https://help.twilio.com/articles/360036052753
- Twilio verified caller IDs: https://www.twilio.com/docs/voice/api/outgoing-caller-ids
- Twilio Media Streams overview: https://www.twilio.com/docs/voice/media-streams
- Twilio `<Stream>` TwiML: https://www.twilio.com/docs/voice/twiml/stream
