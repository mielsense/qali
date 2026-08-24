/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as assistant from "../assistant.js";
import type * as assistantData from "../assistantData.js";
import type * as assistantMaintenance from "../assistantMaintenance.js";
import type * as auth from "../auth.js";
import type * as calendar from "../calendar.js";
import type * as crons from "../crons.js";
import type * as desktopAssistant from "../desktopAssistant.js";
import type * as desktopCalendar from "../desktopCalendar.js";
import type * as domains_assistant_confirm from "../domains/assistant/confirm.js";
import type * as domains_assistant_data from "../domains/assistant/data.js";
import type * as domains_assistant_history from "../domains/assistant/history.js";
import type * as domains_assistant_maintenance from "../domains/assistant/maintenance.js";
import type * as domains_assistant_tables from "../domains/assistant/tables.js";
import type * as domains_assistant_tools from "../domains/assistant/tools.js";
import type * as domains_assistant_validators from "../domains/assistant/validators.js";
import type * as domains_calendar_connections from "../domains/calendar/connections.js";
import type * as domains_calendar_model from "../domains/calendar/model.js";
import type * as domains_calendar_mutations from "../domains/calendar/mutations.js";
import type * as domains_calendar_operations from "../domains/calendar/operations.js";
import type * as domains_calendar_preferences from "../domains/calendar/preferences.js";
import type * as domains_calendar_projection from "../domains/calendar/projection.js";
import type * as domains_calendar_providerIdentity from "../domains/calendar/providerIdentity.js";
import type * as domains_calendar_queries from "../domains/calendar/queries.js";
import type * as domains_calendar_service from "../domains/calendar/service.js";
import type * as domains_calendar_tables from "../domains/calendar/tables.js";
import type * as domains_calendar_validators from "../domains/calendar/validators.js";
import type * as domains_desktop_assistantBroker from "../domains/desktop/assistantBroker.js";
import type * as domains_desktop_calendarBroker from "../domains/desktop/calendarBroker.js";
import type * as domains_desktop_identity from "../domains/desktop/identity.js";
import type * as domains_desktop_multiAccountMigration from "../domains/desktop/multiAccountMigration.js";
import type * as domains_marketing_mutations from "../domains/marketing/mutations.js";
import type * as domains_marketing_tables from "../domains/marketing/tables.js";
import type * as domains_people_queries from "../domains/people/queries.js";
import type * as domains_people_tables from "../domains/people/tables.js";
import type * as healthCheck from "../healthCheck.js";
import type * as http from "../http.js";
import type * as infrastructure_rateLimit from "../infrastructure/rateLimit.js";
import type * as integrations_calendar_errors from "../integrations/calendar/errors.js";
import type * as integrations_calendar_service from "../integrations/calendar/service.js";
import type * as integrations_calendar_types from "../integrations/calendar/types.js";
import type * as jobs_maintenance from "../jobs/maintenance.js";
import type * as lib_assistantLogic from "../lib/assistantLogic.js";
import type * as lib_calendars from "../lib/calendars.js";
import type * as lib_eventReads from "../lib/eventReads.js";
import type * as maintenance from "../maintenance.js";
import type * as people from "../people.js";
import type * as privateData from "../privateData.js";
import type * as schemaPhase from "../schemaPhase.js";
import type * as waitlist from "../waitlist.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  assistant: typeof assistant;
  assistantData: typeof assistantData;
  assistantMaintenance: typeof assistantMaintenance;
  auth: typeof auth;
  calendar: typeof calendar;
  crons: typeof crons;
  desktopAssistant: typeof desktopAssistant;
  desktopCalendar: typeof desktopCalendar;
  "domains/assistant/confirm": typeof domains_assistant_confirm;
  "domains/assistant/data": typeof domains_assistant_data;
  "domains/assistant/history": typeof domains_assistant_history;
  "domains/assistant/maintenance": typeof domains_assistant_maintenance;
  "domains/assistant/tables": typeof domains_assistant_tables;
  "domains/assistant/tools": typeof domains_assistant_tools;
  "domains/assistant/validators": typeof domains_assistant_validators;
  "domains/calendar/connections": typeof domains_calendar_connections;
  "domains/calendar/model": typeof domains_calendar_model;
  "domains/calendar/mutations": typeof domains_calendar_mutations;
  "domains/calendar/operations": typeof domains_calendar_operations;
  "domains/calendar/preferences": typeof domains_calendar_preferences;
  "domains/calendar/projection": typeof domains_calendar_projection;
  "domains/calendar/providerIdentity": typeof domains_calendar_providerIdentity;
  "domains/calendar/queries": typeof domains_calendar_queries;
  "domains/calendar/service": typeof domains_calendar_service;
  "domains/calendar/tables": typeof domains_calendar_tables;
  "domains/calendar/validators": typeof domains_calendar_validators;
  "domains/desktop/assistantBroker": typeof domains_desktop_assistantBroker;
  "domains/desktop/calendarBroker": typeof domains_desktop_calendarBroker;
  "domains/desktop/identity": typeof domains_desktop_identity;
  "domains/desktop/multiAccountMigration": typeof domains_desktop_multiAccountMigration;
  "domains/marketing/mutations": typeof domains_marketing_mutations;
  "domains/marketing/tables": typeof domains_marketing_tables;
  "domains/people/queries": typeof domains_people_queries;
  "domains/people/tables": typeof domains_people_tables;
  healthCheck: typeof healthCheck;
  http: typeof http;
  "infrastructure/rateLimit": typeof infrastructure_rateLimit;
  "integrations/calendar/errors": typeof integrations_calendar_errors;
  "integrations/calendar/service": typeof integrations_calendar_service;
  "integrations/calendar/types": typeof integrations_calendar_types;
  "jobs/maintenance": typeof jobs_maintenance;
  "lib/assistantLogic": typeof lib_assistantLogic;
  "lib/calendars": typeof lib_calendars;
  "lib/eventReads": typeof lib_eventReads;
  maintenance: typeof maintenance;
  people: typeof people;
  privateData: typeof privateData;
  schemaPhase: typeof schemaPhase;
  waitlist: typeof waitlist;
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
