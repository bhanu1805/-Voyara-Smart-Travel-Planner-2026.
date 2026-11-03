# Smart Travel Planner v3

This is an upgraded version of the existing Smart Travel Planner architecture. The original flow is preserved: browser geolocation → Nominatim → OpenStreetMap/Overpass nearby places → OSRM routing → recommendation → itinerary → cost/chatbot. The upgrade adds real-time and persistent features around that core.

## Features covered
1. **Live weather without customer setup**: Open-Meteo current conditions; customers do not need to create an API key.
2. **Accounts + saved history**: SQLite + bcrypt + token sessions.
3. **Reviews/ratings**: user ratings are stored per place and can be used as recommendation feedback.
4. **Currency**: ExchangeRate-API. The open endpoint works without a key; a key can be configured for the standard endpoint.
5. **Route-aware itinerary**: OSRM distance/duration is used while grouping nearby attractions into days.
6. **Group trips**: each member supplies budget + interests; destinations are scored for group compatibility.
7. **Voice input**: Web Speech API in Chrome/compatible browsers.
8. **LLM chatbot**: Anthropic API when `ANTHROPIC_API_KEY` is present; otherwise the original rule-based fallback remains available.
9. **Booking assistance**: Amadeus test inventory where available, with Google Hotels, Booking.com and Google Flights fallback links so customers can still continue searching if API credentials or sandbox inventory fail.
10. **Photo search**: Gemini Vision analyses uploaded travel photos and recommends similar destinations in India. The user does not need to log in, but the site operator must configure a server-side `GEMINI_API_KEY`.
11. **PWA**: manifest + service worker; app shell works offline and visited OSM tiles can be cached by the service worker.
12. **Admin analytics**: protected dashboard showing users, saved trips, average budget and popular destinations.

## Run

```bash
npm install
cp .env.example .env
npm start
```

Open `http://localhost:3030` when `PORT=3030` is set in the root `.env` file; otherwise the default is `http://localhost:3000`.

### Default admin
The database seeds the admin account from `.env`:

- email: `admin@smarttravel.local`
- password: `admin123`

Change these before a real deployment.

## Troubleshooting live services

- **Nearby places:** allow location permission in your browser, click Detect my location, then Find places. The backend tries multiple public Overpass servers; if all are busy, retry in a minute or increase the radius. Place search requires internet.
- **Weather:** allow location access and click Get live weather. The app uses Open-Meteo and does not ask customers for a key. It requires an internet connection.
- **Multilingual assistant:** select English, Hindi, Kannada, Marathi, Tamil or Telugu in the Reply language menu. Basic multilingual replies work without an LLM key; for open-ended AI responses, set `ANTHROPIC_API_KEY` in `.env` and restart the server.
- **Hotels and flights:** live search links to Google Hotels, Booking.com and Google Flights are always offered if Amadeus is not configured or its sandbox returns no results. Amadeus test inventory is not the same as a production booking connection. Flight status may require credentials and can be incomplete.
- **Guest mode:** chatbot and live booking endpoints do not require login; saving trips/reviews still does.

## APIs used
- **OpenStreetMap/Nominatim**: reverse geocoding and destination lookup.
- **Overpass/OpenStreetMap**: nearby attractions, restaurants, parks and shopping places.
- **OSRM**: real driving route distance/duration and itinerary travel-time calculations.
- **Open-Meteo**: current weather without an end-user API key.
- **ExchangeRate-API**: currency conversion; its open endpoint is available without a key and is updated daily.
- **Amadeus Self-Service**: hotel/flight search and flight status in test mode with client ID/secret.
- **Anthropic**: open-ended chatbot when a key is configured.

## Chatbot and live-service troubleshooting

- The chatbot uses the configured Gemini model and tries current Gemini Flash alternatives if the selected model is unavailable or temporarily overloaded. A valid API key and reachable provider are still required for open-ended generative answers.
- The chatbot detects Kannada, Hindi, Tamil, Telugu and other supported input scripts so a user can ask in their language without changing the language menu first. The selected language remains the preference for Latin-script messages.
- Weather questions for common Indian destinations (including Goa, Hampi, Belagavi, Hosapete, Gokarna, Mangaluru, Ooty and Coorg) can resolve coordinates without depending entirely on the geocoder. Live weather still requires internet access to Open-Meteo.
- Open `http://localhost:3030/api/health` to confirm which project/server is running, the configured port, whether an AI key is detected (the key itself is never exposed), and which providers the app will use.

## Production-minded service behaviour

- Weather is served by Open-Meteo, so customers never need to bring their own weather key. The browser only sends coordinates; the server calls the provider.
- Nearby-place searches try multiple public Overpass mirrors, then a Photon/OpenStreetMap backup provider. Successful results are cached in server memory for 30 minutes and reused if providers are temporarily unavailable. Live nearby results still require internet and at least one reachable public map-data provider.
- Photo search is available without a customer account. Gemini Vision is tried across configured/current fallback model names with retry handling. If the AI provider is overloaded or no key is configured, the app shows clearly labelled backup suggestions based on the uploaded filename; these are not true visual matches. Never place an API secret in `public/` or commit `.env`.
- Hotels/flights always expose external search links when Amadeus is missing, unavailable, or has no sandbox results. Amadeus test results are not guaranteed production booking inventory. Booking and payment happen on the linked provider's website.
- This is a project-ready prototype, not yet a certified production travel agency. Before public commercial launch, add HTTPS, rate limiting, monitoring, privacy/consent notices, production booking-provider agreements, secure secret management, accessibility testing, and operational support.

## Run

```bash
npm install
cp .env.example .env
# Add GEMINI_API_KEY only if you want AI chatbot and photo matching.
npm start
```

Open `http://localhost:3030` when `PORT=3030` is set in the root `.env` file; otherwise the default is `http://localhost:3000`. Browser geolocation works on localhost or an HTTPS deployment; allow location access when prompted. Saving trips and reviews requires login; browsing nearby places, weather, photo search and booking links do not require an account.


## Important configuration notes
- The `.env` file must be created in the same folder as `server.js` (project root). Copy `.env.example` to `.env`, set `GEMINI_API_KEY` there for Voyara and photo matching, then restart `npm start`. A key entered in another copy of the project will not be read by this running server.
- Weather uses Open-Meteo and does not require a user-supplied weather key. Browser location permission is still required for weather at the current location.
- Nearby places use public OpenStreetMap/Overpass services. They may temporarily rate-limit or fail; the app retries multiple endpoints but cannot guarantee public-provider uptime.
- Friend chat is basic in-app account-to-account messaging with 5-second polling. It is not WhatsApp, has no push notifications/end-to-end encryption, and requires both people to register and connect.
- Before public deployment, set a strong `ADMIN_EMAIL` and `ADMIN_PASSWORD`, use HTTPS, add rate limits, email verification, password reset, privacy/retention policies, backups and production monitoring. Do not deploy the sample admin password.


### Reliability notes (updated)
- The AI service retries transient failures and tries alternate Gemini model IDs before returning a graceful fallback. If all AI endpoints are overloaded or the API key/quota is invalid, a real generative answer cannot be guaranteed until the provider becomes available.
- The chatbot returns a built-in fallback instead of a raw HTTP 502 when AI is temporarily unavailable. Live weather remains sourced from Open-Meteo when reachable.
- Nearby search tries Overpass and then Photon, both OpenStreetMap-based services. These are public internet services and can occasionally be unavailable.
