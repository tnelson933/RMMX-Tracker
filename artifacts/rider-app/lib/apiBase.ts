// Base URL for every API call. Builds set EXPO_PUBLIC_DOMAIN (eas.json); local
// testing can set EXPO_PUBLIC_API_URL to a full URL such as http://10.0.2.2:8080
// to talk to a dev API without https.
const override = process.env.EXPO_PUBLIC_API_URL?.replace(/\/+$/, "");
const domain = process.env.EXPO_PUBLIC_DOMAIN;

export const API_BASE_URL = override || (domain ? `https://${domain}` : "");
