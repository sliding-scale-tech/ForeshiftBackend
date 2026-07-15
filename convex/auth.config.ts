// Tells Convex to trust JWTs minted by Clerk. The frontend passes a Clerk token
// (from the "convex" JWT template) with each request; Convex verifies it against
// this issuer and exposes the claims via ctx.auth.getUserIdentity().
//
// Set CLERK_JWT_ISSUER_DOMAIN in the Convex deployment env to your Clerk Frontend
// API / issuer URL (e.g. https://<your-app>.clerk.accounts.dev). applicationID
// must match the JWT template name in Clerk ("convex").
export default {
  providers: [
    {
      domain: process.env.CLERK_JWT_ISSUER_DOMAIN,
      applicationID: "convex",
    },
  ],
};
