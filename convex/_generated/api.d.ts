/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as ai from "../ai.js";
import type * as coefficients from "../coefficients.js";
import type * as crons from "../crons.js";
import type * as demand from "../demand.js";
import type * as events from "../events.js";
import type * as http from "../http.js";
import type * as lib_aggregate from "../lib/aggregate.js";
import type * as lib_bubble from "../lib/bubble.js";
import type * as lib_classify from "../lib/classify.js";
import type * as lib_formula from "../lib/formula.js";
import type * as lib_gemini from "../lib/gemini.js";
import type * as lib_geo from "../lib/geo.js";
import type * as lib_orchestrator from "../lib/orchestrator.js";
import type * as lib_outlook from "../lib/outlook.js";
import type * as lib_providers from "../lib/providers.js";
import type * as lib_resolve from "../lib/resolve.js";
import type * as lib_svix from "../lib/svix.js";
import type * as lib_ticketmaster from "../lib/ticketmaster.js";
import type * as lib_vocab from "../lib/vocab.js";
import type * as lib_weatherSeverity from "../lib/weatherSeverity.js";
import type * as lib_weatherapi from "../lib/weatherapi.js";
import type * as myFunctions from "../myFunctions.js";
import type * as operatorWeek from "../operatorWeek.js";
import type * as outlook from "../outlook.js";
import type * as users from "../users.js";
import type * as weather from "../weather.js";
import type * as zones from "../zones.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  ai: typeof ai;
  coefficients: typeof coefficients;
  crons: typeof crons;
  demand: typeof demand;
  events: typeof events;
  http: typeof http;
  "lib/aggregate": typeof lib_aggregate;
  "lib/bubble": typeof lib_bubble;
  "lib/classify": typeof lib_classify;
  "lib/formula": typeof lib_formula;
  "lib/gemini": typeof lib_gemini;
  "lib/geo": typeof lib_geo;
  "lib/orchestrator": typeof lib_orchestrator;
  "lib/outlook": typeof lib_outlook;
  "lib/providers": typeof lib_providers;
  "lib/resolve": typeof lib_resolve;
  "lib/svix": typeof lib_svix;
  "lib/ticketmaster": typeof lib_ticketmaster;
  "lib/vocab": typeof lib_vocab;
  "lib/weatherSeverity": typeof lib_weatherSeverity;
  "lib/weatherapi": typeof lib_weatherapi;
  myFunctions: typeof myFunctions;
  operatorWeek: typeof operatorWeek;
  outlook: typeof outlook;
  users: typeof users;
  weather: typeof weather;
  zones: typeof zones;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
