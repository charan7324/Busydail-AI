# BusyDail — AI Telecalling Platform

BusyDail is a web-based AI telecalling platform designed to help businesses manage AI voice agents, organise contacts and campaigns, place outbound calls, review call activity, and automate follow-up communication.

The repository contains a static HTML/CSS/JavaScript frontend and a Node.js backend that connects Twilio voice calls to Google's Gemini Live API. Supabase is used for authentication and application data; Razorpay is used for payment verification and credit top-ups.

> **Project status:** This README documents the implementation present in this repository. It is not a claim that every feature is production-hardened. Configure and test the external services, database schema, security policies, and telephony webhooks before using real customer data or making live calls.

## Contents

- [Features](#features)
- [Architecture](#architecture)
- [Repository structure](#repository-structure)
- [Technology stack](#technology-stack)
- [Prerequisites](#prerequisites)
- [Configuration](#configuration)
- [Run locally](#run-locally)
- [Frontend pages](#frontend-pages)
- [Backend endpoints](#backend-endpoints)
- [Supabase setup](#supabase-setup)
- [Twilio setup](#twilio-setup)
- [Gemini setup](#gemini-setup)
- [Razorpay setup](#razorpay-setup)
- [Deployment](#deployment)
- [Security and production checklist](#security-and-production-checklist)
- [Troubleshooting](#troubleshooting)

## Features

The current frontend and backend code provide the following product areas:

- **AI voice agents:** Create and manage agents with names, instructions, and agent configuration.
- **Agent teams:** Organise agents into groups and configure routing conditions.
- **Contacts:** Maintain contact records for outbound calling.
- **Campaign management:** Create campaigns, manage target numbers, and review campaign activity.
- **Outbound calls:** Initiate calls through the business's configured Twilio account.
- **Live AI conversations:** Stream call audio between Twilio Media Streams and the Gemini Live API.
- **Call history:** Review call records, transcripts, and AI-generated call summaries where available.
- **Dashboard and analytics:** View business activity and call-related information.
- **Post-call SMS automation:** Optionally send a configured follow-up SMS, with optional media URL, through Twilio.
- **Background audio:** Mix configurable ambient audio into the generated call audio.
- **Billing and credits:** Display credit packages and verify Razorpay payments before adding credits through a Supabase database function.
- **Workspace settings:** Configure Twilio credentials, phone number, SMS automation, and live-call task instructions.

Availability of each feature depends on the corresponding Supabase tables, columns, database policies, and external service configuration being present.

## Architecture

```text
                        ┌──────────────────────────┐
                        │       BusyDail UI        │
                        │ HTML / CSS / JavaScript  │
                        └────────────┬─────────────┘
                                     │
                   ┌─────────────────┴─────────────────┐
                   │                                   │
                   ▼                                   ▼
        ┌────────────────────┐              ┌────────────────────┐
        │      Supabase      │              │  BusyDail Backend  │
        │ Auth + Application │              │ Node.js / Fastify  │
        │       Data         │              │ REST + WebSocket   │
        └────────────────────┘              └─────────┬──────────┘
                                                      │
                            ┌─────────────────────────┼─────────────────────┐
                            │                         │                     │
                            ▼                         ▼                     ▼
                    ┌─────────────┐           ┌──────────────┐      ┌─────────────┐
                    │    Twilio   │           │ Gemini Live  │      │  Razorpay   │
                    │ Voice / SMS │           │  API / Audio │      │  Payments   │
                    └─────────────┘           └──────────────┘      └─────────────┘
```

### Frontend

`BusyDail-Frontend/` contains static HTML pages and browser-side JavaScript. Supabase's JavaScript client handles user authentication and direct data access. The call and payment flows communicate with the backend service.

### Backend

`BusyDail-Backend/server.js` runs a Fastify server. It handles outbound call initiation, Twilio webhooks, WebSocket media streaming, Gemini Live API communication, audio conversion/mixing, call records, automated SMS, and Razorpay payment verification.

### Data and external services

- **Supabase:** Authentication, business workspaces, agents, groups, contacts, campaigns, calls, and credit-related data.
- **Twilio:** Phone calls, media streams, and SMS.
- **Google Gemini Live API:** Real-time conversational voice generation and response.
- **Razorpay:** Payment status verification.
- **FFmpeg:** Audio decoding and resampling in the backend.

## Repository structure

```text
BusyDail/
├── README.md
├── .gitignore
├── BusyDail-Frontend/
│   ├── index.html
│   ├── login.html
│   ├── signup.html
│   ├── onboarding.html
│   ├── dashboard.html
│   ├── agents.html
│   ├── groups.html
│   ├── contacts.html
│   ├── campaigns.html
│   ├── make-call.html
│   ├── calls.html
│   ├── billing.html
│   ├── settings.html
│   ├── supabase.js
│   ├── auth-helper.js
│   ├── style.css
│   └── image assets
└── BusyDail-Backend/
    ├── server.js
    ├── package.json
    ├── package-lock.json
    ├── .env.example
    └── render.yaml
```

## Technology stack

| Layer | Technology |
|---|---|
| Frontend | HTML, CSS, JavaScript, Tailwind CSS CDN |
| Authentication and database | Supabase, `@supabase/supabase-js` |
| Backend runtime | Node.js (ES modules) |
| HTTP server | Fastify 5 |
| WebSockets | `@fastify/websocket`, `ws` |
| Voice AI | Google Gemini Live API (WebSocket) |
| Telephony and SMS | Twilio REST API and Media Streams |
| Payments | Razorpay Payments API |
| Audio processing | FFmpeg |
| Hosting configuration | Render |

## Prerequisites

Install or obtain the following before running the project:

1. **Node.js** — use a currently supported LTS release compatible with the dependencies in `BusyDail-Backend/package-lock.json`.
2. **npm** — included with Node.js.
3. **FFmpeg** — available on the backend host and on its `PATH`.
4. **Supabase project** — URL, anon/public key, service-role key, database tables, and authentication configuration.
5. **Google AI Studio / Gemini API key** with access to the configured Gemini Live model.
6. **Twilio account** with a voice-capable phone number and the required calling/SMS permissions.
7. **Razorpay account** if credit purchases are enabled.
8. A static web host for the frontend, or a local static file server during development.

## Configuration

### 1. Backend environment variables

Move into the backend directory and create a local environment file:

```bash
cd BusyDail-Backend
cp .env.example .env
```

On Windows PowerShell:

```powershell
Copy-Item .env.example .env
```

Set the values in `BusyDail-Backend/.env`:

```env
PORT=5050
GEMINI_API_KEY=your_gemini_api_key
SUPABASE_URL=https://YOUR_PROJECT.supabase.co
SUPABASE_SERVICE_KEY=your_supabase_service_role_key
RAZORPAY_KEY_ID=your_razorpay_key_id
RAZORPAY_KEY_SECRET=your_razorpay_key_secret
```

Notes:

- `GEMINI_API_KEY`, `SUPABASE_URL`, and `SUPABASE_SERVICE_KEY` are required by the current backend startup code. The server exits if they are missing.
- `PORT` defaults to `5050` when not supplied.
- Razorpay credentials are needed for the payment-verification flow. The current backend code reads them from the environment when `/verify-payment` is called.
- Never commit `.env` or expose the Supabase service-role key, Razorpay secret, or Gemini API key in frontend code.

### 2. Frontend Supabase configuration

The current frontend Supabase client is configured in:

```text
BusyDail-Frontend/supabase.js
```

It currently contains a Supabase project URL and an anon/public key in the browser bundle. A Supabase anon key is intended for client-side use only when Row Level Security (RLS) and policies are correctly configured. Confirm that these values point to the intended project before deployment.

For a safer multi-environment setup, move frontend configuration into a generated public config file or build-time environment configuration. Do not put service-role keys in the frontend.

### 3. Backend URL configuration

The frontend currently references the deployed backend URL in some pages:

```text
https://ai-telecaller-f47c.onrender.com
```

Update the relevant `SERVER_URL` / fetch references when using a different backend deployment. Prefer one shared frontend configuration value rather than repeating the URL across pages.

## Run locally

### 1. Install backend dependencies

```bash
cd BusyDail-Backend
npm ci
```

### 2. Install FFmpeg

The backend invokes `ffmpeg` as a child process to convert audio. Install FFmpeg and ensure the executable is available in the system `PATH`.

Check installation:

```bash
ffmpeg -version
```

On Windows, install FFmpeg using a trusted package manager or the official FFmpeg distribution, then reopen the terminal so the updated `PATH` is loaded.

### 3. Configure environment

Create and fill in `BusyDail-Backend/.env` as described above.

### 4. Start the backend

```bash
npm start
```

The server listens on the configured port (default `5050`) and binds to `0.0.0.0`.

Check the health response in a browser or terminal:

```text
http://localhost:5050/
```

The current root route returns a simple message confirming that the Twilio + Gemini media-stream server is running.

### 5. Serve the frontend

The frontend is a collection of static HTML files. Serve the `BusyDail-Frontend` directory using a static web server rather than opening the files directly with `file://`, because the pages use JavaScript modules and remote services.

For example, with a local static server such as VS Code Live Server, serve:

```text
BusyDail-Frontend/index.html
```

Configure the frontend backend URL to `http://localhost:5050` for local testing. Ensure the browser's origin and backend CORS configuration are appropriate for your environment.

## Frontend pages

| Page | Purpose |
|---|---|
| `index.html` | Public landing page and product overview |
| `signup.html` | Create an account |
| `login.html` | Sign in |
| `onboarding.html` | Set up a workspace |
| `dashboard.html` | Workspace overview and activity |
| `agents.html` | Create and manage AI agents |
| `groups.html` | Create and manage agent teams and routing |
| `contacts.html` | Manage contacts |
| `campaigns.html` | Manage outbound campaigns and campaign analytics |
| `make-call.html` | Configure and initiate an outbound call |
| `calls.html` | Review call history, transcripts, and summaries |
| `billing.html` | View credit packages and payment status |
| `settings.html` | Configure workspace, Twilio, and automation settings |

## Backend endpoints

The following routes are present in the current backend source:

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/` | Backend health/message route |
| `POST` | `/make-call` | Initiate an outbound call using the business's Twilio credentials |
| `ALL` | `/incoming-call` | Twilio incoming-call webhook; returns TwiML for the media stream |
| `POST` | `/call-status` | Receive Twilio call status callbacks and update call records |
| `GET` (WebSocket) | `/media-stream` | Handle Twilio Media Streams and the Gemini Live conversation |
| `POST` | `/verify-payment` | Verify a Razorpay payment and call the Supabase `add_credits` database function |

The `/make-call` route expects a destination number and business ID in its request body. The precise request and response behaviour should be checked against `server.js` before building a separate client integration.

## Supabase setup

Create a Supabase project and configure authentication providers and redirect URLs for the frontend domain.

The current source references these tables:

- `businesses`
- `agents`
- `ai_groups`
- `group_members`
- `contacts`
- `campaigns`
- `calls`

The payment flow also calls a PostgreSQL RPC function:

- `add_credits(business_id_input, amount_to_add)`

The repository archive does not include database migration files or a complete SQL schema. Therefore, the exact columns, constraints, indexes, triggers, and RLS policies must be established from the queries in the frontend/backend code and the intended product rules. Do not assume that creating tables with only the names above is sufficient.

Before enabling real users:

1. Create and verify every required table and column used by the application.
2. Add foreign keys and indexes for relationships and frequently queried fields.
3. Enable RLS on tables accessible through the frontend Supabase client.
4. Add policies that restrict records to the authenticated user's business/workspace.
5. Ensure the backend service-role key is only used server-side.
6. Implement and test the `add_credits` function with appropriate validation and transaction safety.
7. Confirm that a user cannot read or modify another business's records.

## Twilio setup

1. Create/configure a Twilio account and a voice-capable phone number.
2. Add the account SID, auth token, and Twilio phone number to the relevant business/workspace settings in BusyDail.
3. Configure the phone number's incoming voice webhook to the deployed backend's `/incoming-call` route.
4. Configure the status callback to the deployed backend's `/call-status` route where required by the call flow.
5. Ensure the backend is publicly reachable over HTTPS for Twilio webhooks.
6. Ensure the WebSocket media-stream URL is publicly reachable and uses secure WebSockets in production.
7. Test with a number you control before making calls to other recipients.

The application also supports optional post-call SMS automation. Configure the business's Twilio SMS settings and automation text in the workspace settings. If a media URL is supplied, Twilio will be asked to include it in the SMS.

## Gemini setup

The backend connects to Google's Gemini Live API using the `GEMINI_API_KEY` environment variable. The model and voice are currently selected in `server.js`:

- Model: `gemini-2.5-flash-native-audio-preview-12-2025`
- Voice: `Aoede`

Model availability and API behaviour can change. Confirm that the configured model is available to your Google AI project and that the API key has the required access. If the model identifier is retired or unavailable, update it deliberately and test the real-time audio input/output formats before deployment.

## Razorpay setup

If enabling credit purchases:

1. Configure the Razorpay key ID and key secret in the backend environment.
2. Configure the matching public key in the billing frontend if required by the checkout flow.
3. Ensure the frontend's checkout order-creation flow and backend verification flow use the same order/payment details.
4. Test successful, failed, cancelled, duplicate, and replayed payment scenarios in Razorpay test mode.
5. Make credit updates idempotent and validate the amount and business ownership server-side.

**Important:** The current `/verify-payment` implementation accepts `paymentId`, `businessId`, and `creditsToAdd`, checks the payment status, and invokes `add_credits`. Before production use, strengthen this flow by verifying the expected order, amount, currency, business ownership, and payment capture status on the server, and prevent repeated credit grants for the same payment ID.

## Deployment

### Backend on Render

A `render.yaml` file is included in `BusyDail-Backend/`. It defines a Node web service with an FFmpeg installation step and `node server.js` as the start command.

When creating the Render service:

1. Connect the Git repository.
2. Set the backend root directory to `BusyDail-Backend` if deploying from a monorepo.
3. Confirm the build and start commands from `render.yaml` are applied.
4. Add all required environment variables in Render's environment settings.
5. Confirm FFmpeg is installed and available to the process.
6. Deploy and test the `/` health route.
7. Configure Twilio webhooks to use the deployed HTTPS URL.
8. Configure the frontend to use the deployed backend URL.

Do not place secrets directly in `render.yaml` or commit them to Git.

### Frontend hosting

Deploy the contents of `BusyDail-Frontend/` to a static hosting provider such as Netlify, Vercel, or another static web host. Configure the frontend's Supabase project settings and backend base URL for the deployment environment.

After deployment, configure Supabase authentication redirect URLs and allowed origins as appropriate.

## Security and production checklist

The current source is a starting point and should receive a security review before production use. In particular:

- Replace permissive backend CORS (`Access-Control-Allow-Origin: *`) with an explicit allowlist of trusted frontend origins.
- Add authentication and authorisation to backend routes that access business data or initiate calls. Do not trust a client-supplied `businessId` by itself.
- Validate and normalise all request bodies, phone numbers, URLs, and numeric payment values.
- Verify Twilio webhook signatures before trusting webhook requests.
- Keep Supabase service-role, Twilio auth, Gemini, and Razorpay secrets on the server only.
- Apply strict Supabase RLS policies to all tenant-owned data.
- Protect payment verification against replay, duplicate crediting, amount tampering, and business-ID tampering.
- Add rate limits and abuse controls to call initiation and payment endpoints.
- Add request IDs, structured logs, error monitoring, and retention policies for call data.
- Avoid logging API keys, auth tokens, full payment details, or unnecessary personal information.
- Obtain required consent and comply with applicable telecom, privacy, and recording rules in every region where calls are made.
- Provide clear disclosure where required that the caller is AI-generated and that calls may be recorded or processed.
- Set spending limits and call-duration limits to reduce unexpected telephony and AI usage.
- Test failure cases: provider downtime, WebSocket disconnects, invalid audio, call hangups, duplicate callbacks, and payment retries.

## Troubleshooting

### Backend exits with `Missing GEMINI_API_KEY`

Add a valid `GEMINI_API_KEY` to `BusyDail-Backend/.env` and restart the backend.

### Backend exits with missing Supabase credentials

Set both `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` in the backend environment. Use the service-role key only on the server.

### `ffmpeg` command not found

Install FFmpeg and ensure its executable is on `PATH`. Restart the terminal or hosting service after updating the environment.

### Browser frontend cannot reach the backend

Check the backend URL configured in the frontend, confirm the backend is running, and inspect browser developer tools for CORS or network errors. For local development, make sure the frontend points to the local backend rather than the deployed Render URL.

### Twilio call does not connect to the AI stream

Confirm that `/incoming-call` is publicly accessible over HTTPS, the returned TwiML contains the correct WebSocket URL, `/media-stream` is reachable over secure WebSockets, and the Twilio number/account has voice permissions. Check backend logs for Gemini connection and audio-format errors.

### Call records or dashboard data are missing

Check Supabase connectivity, table names and columns, foreign keys, RLS policies, and backend logs. A service-role client on the backend and an anon-key client in the browser have different access behaviour.

### Payment succeeds but credits are not added

Check Razorpay credentials, payment status, the `/verify-payment` response, and the Supabase `add_credits` RPC function. Also verify that the payment has not already been processed and that the function accepts the exact parameter names used by the backend.

## Development notes

- The backend package is an ES module (`"type": "module"`).
- Start the backend from `BusyDail-Backend/` using `npm start`.
- The current `package.json` does not define an automated test suite; its `test` script is a placeholder that exits with an error. Add real tests before relying on CI or release checks.
- The backend currently imports Fastify and its WebSocket/form-body plugins. Review and remove unused dependencies only after confirming they are not needed by future code.
- Keep frontend and backend configuration environment-specific. Avoid hardcoding deployment URLs in multiple HTML files.

## License

No project licence is currently specified in the repository. Add a `LICENSE` file before distributing or accepting external contributions, and clarify ownership and permitted use of the source code.
