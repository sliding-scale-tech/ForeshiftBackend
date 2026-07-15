import { clerkMiddleware } from "@clerk/nextjs/server";

// Passive: attach Clerk's auth context to every request, but don't force a
// redirect here. The real security boundary is server-side — every Convex
// function that touches coefficients calls requireAdmin(). The page itself shows
// a sign-in prompt when signed out and the editor only to admins.
export default clerkMiddleware();

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};
