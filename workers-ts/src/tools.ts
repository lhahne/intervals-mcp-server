import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import type { RequestContext } from "./types.js";
import { makeIntervalsRequest, requestCredentials, requireAthleteId, summarizeCollection, summarizeObject } from "./intervals.js";
import { daysFromNow, pretty, resolveDateRange, todayIso, validateAthleteId, validateDate } from "./utils.js";

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;
type IntervalsError = { error: true; message: string; statusCode?: number };

function ctx(env: RequestContext["env"], extra: Extra): RequestContext {
  return { env, auth: extra.authInfo };
}

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function withResolvedCredentials(env: RequestContext["env"], extra: Extra) {
  return requestCredentials(ctx(env, extra));
}

function resolveAthleteIdForRequest(env: RequestContext["env"], extra: Extra, athleteId?: string | null): string {
  const credentials = withResolvedCredentials(env, extra);
  return requireAthleteId(athleteId ?? credentials.athleteId);
}

function intervalError(prefix: string, result: { error: true; message: string }): string {
  return `${prefix}: ${result.message}`;
}

function isIntervalsError(result: unknown): result is IntervalsError {
  return Boolean(
    result &&
      typeof result === "object" &&
      "error" in result &&
      "message" in result &&
      (result as Record<string, unknown>).error === true,
  );
}

export function registerTools(server: McpServer, env: RequestContext["env"], repositoryFactory: () => import("./repository.js").D1AuthRepository) {
  server.registerTool(
    "get_activities",
    {
      description: "Get a list of activities for an athlete from Intervals.icu",
      inputSchema: {
        athlete_id: z.string().optional(),
        api_key: z.string().optional(),
        start_date: z.string().optional(),
        end_date: z.string().optional(),
        limit: z.number().int().default(10),
        include_unnamed: z.boolean().default(false),
      },
    },
    async ({ athlete_id, api_key, start_date, end_date, limit = 10, include_unnamed = false }, extra) => {
      const athleteId = resolveAthleteIdForRequest(env, extra, athlete_id);
      const [start, end] = resolveDateRange(start_date, end_date);
      const apiLimit = include_unnamed ? limit : limit * 3;
      const result = await makeIntervalsRequest(ctx(env, extra), `/athlete/${athleteId}/activities`, {
        apiKey: api_key,
        params: { oldest: start, newest: end, limit: apiLimit },
      });
      if (isIntervalsError(result)) {
        return textResult(intervalError("Error fetching activities", result));
      }
      const items = Array.isArray(result) ? result : [];
      const filtered = include_unnamed ? items : items.filter((item) => item.name && item.name !== "Unnamed");
      return textResult(
        filtered.length
          ? summarizeCollection("Activities", filtered.slice(0, limit), ["id", "name", "type", "start_date_local", "distance", "moving_time"])
          : `No ${include_unnamed ? "valid" : "named"} activities found for athlete ${athleteId} in the specified date range.`,
      );
    },
  );

  server.registerTool(
    "get_activity_details",
    {
      description: "Get detailed information for a specific activity from Intervals.icu",
      inputSchema: { activity_id: z.string(), api_key: z.string().optional() },
    },
    async ({ activity_id, api_key }, extra) => {
      const result = await makeIntervalsRequest(ctx(env, extra), `/activity/${activity_id}`, { apiKey: api_key });
      if (isIntervalsError(result)) {
        return textResult(intervalError("Error fetching activity details", result));
      }
      const activity = Array.isArray(result) ? result[0] : result;
      return textResult(activity ? summarizeObject(activity, ["id", "name", "type", "start_date_local", "description"]) : `No details found for activity ${activity_id}.`);
    },
  );

  server.registerTool(
    "get_activity_intervals",
    {
      description: "Get interval data for a specific activity from Intervals.icu",
      inputSchema: { activity_id: z.string(), api_key: z.string().optional() },
    },
    async ({ activity_id, api_key }, extra) => {
      const result = await makeIntervalsRequest(ctx(env, extra), `/activity/${activity_id}/intervals`, { apiKey: api_key });
      if (isIntervalsError(result)) {
        return textResult(intervalError("Error fetching intervals", result));
      }
      return textResult(result ? pretty(result) : `No interval data found for activity ${activity_id}.`);
    },
  );

  server.registerTool(
    "get_activity_streams",
    {
      description: "Get stream data for a specific activity from Intervals.icu",
      inputSchema: { activity_id: z.string(), api_key: z.string().optional(), stream_types: z.string().optional() },
    },
    async ({ activity_id, api_key, stream_types }, extra) => {
      const result = await makeIntervalsRequest(ctx(env, extra), `/activity/${activity_id}/streams`, {
        apiKey: api_key,
        params: { types: stream_types ?? "time,watts,heartrate,cadence,altitude,distance,velocity_smooth" },
      });
      if (isIntervalsError(result)) {
        return textResult(intervalError("Error fetching activity streams", result));
      }
      const streams = Array.isArray(result) ? result : [];
      return textResult(streams.length ? summarizeCollection(`Activity Streams for ${activity_id}`, streams, ["type", "name", "valueType", "data"]) : `No stream data found for activity ${activity_id}.`);
    },
  );

  server.registerTool(
    "get_activity_messages",
    {
      description: "Get messages for a specific activity from Intervals.icu",
      inputSchema: { activity_id: z.string(), api_key: z.string().optional() },
    },
    async ({ activity_id, api_key }, extra) => {
      const result = await makeIntervalsRequest(ctx(env, extra), `/activity/${activity_id}/messages`, { apiKey: api_key });
      if (isIntervalsError(result)) {
        return textResult(intervalError("Error fetching activity messages", result));
      }
      const messages = Array.isArray(result) ? result : [];
      return textResult(messages.length ? summarizeCollection(`Messages for activity ${activity_id}`, messages, ["id", "author", "content", "created"]) : `No messages found for activity ${activity_id}.`);
    },
  );

  server.registerTool(
    "add_activity_message",
    {
      description: "Add a message to an activity on Intervals.icu",
      inputSchema: { activity_id: z.string(), content: z.string(), api_key: z.string().optional() },
    },
    async ({ activity_id, content, api_key }, extra) => {
      const result = await makeIntervalsRequest(ctx(env, extra), `/activity/${activity_id}/messages`, {
        apiKey: api_key,
        method: "POST",
        data: { content },
      });
      if (isIntervalsError(result)) {
        return textResult(intervalError("Error adding message to activity", result));
      }
      const id = !Array.isArray(result) && result ? result.id : undefined;
      return textResult(id ? `Successfully added message (ID: ${id}) to activity ${activity_id}.` : `Message appears to have been added to activity ${activity_id}.`);
    },
  );

  server.registerTool(
    "get_events",
    {
      description: "Get events for an athlete from Intervals.icu",
      inputSchema: { athlete_id: z.string().optional(), api_key: z.string().optional(), start_date: z.string().optional(), end_date: z.string().optional() },
    },
    async ({ athlete_id, api_key, start_date, end_date }, extra) => {
      const athleteId = resolveAthleteIdForRequest(env, extra, athlete_id);
      const start = start_date ?? todayIso();
      const end = end_date ?? daysFromNow(30);
      const result = await makeIntervalsRequest(ctx(env, extra), `/athlete/${athleteId}/events`, {
        apiKey: api_key,
        params: { oldest: start, newest: end },
      });
      if (isIntervalsError(result)) {
        return textResult(intervalError("Error fetching events", result));
      }
      const events = Array.isArray(result) ? result : [];
      return textResult(events.length ? summarizeCollection("Events", events, ["id", "name", "category", "type", "start_date_local"]) : `No events found for athlete ${athleteId} in the specified date range.`);
    },
  );

  server.registerTool(
    "get_event_by_id",
    {
      description: "Get detailed information for a specific event from Intervals.icu",
      inputSchema: { event_id: z.string(), athlete_id: z.string().optional(), api_key: z.string().optional() },
    },
    async ({ event_id, athlete_id, api_key }, extra) => {
      const athleteId = resolveAthleteIdForRequest(env, extra, athlete_id);
      const result = await makeIntervalsRequest(ctx(env, extra), `/athlete/${athleteId}/event/${event_id}`, { apiKey: api_key });
      if (isIntervalsError(result)) {
        return textResult(intervalError("Error fetching event details", result));
      }
      return textResult(result ? summarizeObject(result, ["id", "name", "category", "type", "start_date_local", "description"]) : `No details found for event ${event_id}.`);
    },
  );

  server.registerTool(
    "delete_event",
    {
      description: "Delete an event for an athlete from Intervals.icu",
      inputSchema: { event_id: z.string(), athlete_id: z.string().optional(), api_key: z.string().optional() },
    },
    async ({ event_id, athlete_id, api_key }, extra) => {
      const athleteId = resolveAthleteIdForRequest(env, extra, athlete_id);
      const result = await makeIntervalsRequest(ctx(env, extra), `/athlete/${athleteId}/events/${event_id}`, { apiKey: api_key, method: "DELETE" });
      if (isIntervalsError(result)) {
        return textResult(intervalError("Error deleting event", result));
      }
      return textResult(typeof result === "object" && result ? pretty(result) : `Deleted event ${event_id}.`);
    },
  );

  server.registerTool(
    "delete_events_by_date_range",
    {
      description: "Delete events for an athlete in the specified date range",
      inputSchema: { start_date: z.string(), end_date: z.string(), athlete_id: z.string().optional(), api_key: z.string().optional() },
    },
    async ({ start_date, end_date, athlete_id, api_key }, extra) => {
      const athleteId = resolveAthleteIdForRequest(env, extra, athlete_id);
      validateDate(start_date);
      validateDate(end_date);
      const fetched = await makeIntervalsRequest(ctx(env, extra), `/athlete/${athleteId}/events`, {
        apiKey: api_key,
        params: { oldest: start_date, newest: end_date },
      });
      if (isIntervalsError(fetched)) {
        return textResult(intervalError("Error deleting events", fetched));
      }
      const events = Array.isArray(fetched) ? fetched : [];
      const failed: string[] = [];
      for (const event of events) {
        const id = event.id ? String(event.id) : "";
        if (!id) {
          failed.push("unknown (missing ID)");
          continue;
        }
        const deletion = await makeIntervalsRequest(ctx(env, extra), `/athlete/${athleteId}/events/${id}`, { apiKey: api_key, method: "DELETE" });
        if (isIntervalsError(deletion)) {
          failed.push(`${id} (${deletion.message})`);
        }
      }
      return textResult(`Deleted ${events.length - failed.length} events. Failed to delete ${failed.length} events: ${failed.length ? failed.join(", ") : "none"}`);
    },
  );

  server.registerTool(
    "add_or_update_event",
    {
      description: "Create or update a workout event on the athlete calendar",
      inputSchema: {
        workout_type: z.string(),
        name: z.string(),
        athlete_id: z.string().optional(),
        api_key: z.string().optional(),
        event_id: z.string().optional(),
        start_date: z.string().optional(),
        description: z.string().optional(),
        workout_doc: z.record(z.string(), z.any()).optional(),
        moving_time: z.number().optional(),
        distance: z.number().optional(),
      },
    },
    async ({ workout_type, name, athlete_id, api_key, event_id, start_date, description, workout_doc, moving_time, distance }, extra) => {
      const athleteId = resolveAthleteIdForRequest(env, extra, athlete_id);
      const eventData: Record<string, unknown> = {
        start_date_local: `${start_date ?? todayIso()}T00:00:00`,
        category: "WORKOUT",
        name,
        type: workout_type,
      };
      if (description !== undefined) eventData.description = description;
      else if (workout_doc !== undefined) eventData.description = pretty(workout_doc);
      if (moving_time !== undefined) eventData.moving_time = moving_time;
      if (distance !== undefined) eventData.distance = distance;
      const result = await makeIntervalsRequest(ctx(env, extra), `/athlete/${athleteId}/events${event_id ? `/${event_id}` : ""}`, {
        apiKey: api_key,
        method: event_id ? "PUT" : "POST",
        data: eventData,
      });
      if (isIntervalsError(result)) {
        return textResult(intervalError(`Error ${event_id ? "updating" : "creating"} event`, result));
      }
      return textResult(`${event_id ? "Successfully updated" : "Successfully created"} event:\n\n${pretty(result)}`);
    },
  );

  server.registerTool(
    "create_bulk_events",
    {
      description: "Create or update multiple events in a single request",
      inputSchema: {
        events: z.array(z.record(z.string(), z.any())),
        athlete_id: z.string().optional(),
        api_key: z.string().optional(),
        upsert_on_uid: z.boolean().default(false),
        update_plan_applied: z.boolean().default(false),
      },
    },
    async ({ events, athlete_id, api_key, upsert_on_uid = false, update_plan_applied = false }, extra) => {
      const athleteId = resolveAthleteIdForRequest(env, extra, athlete_id);
      const result = await makeIntervalsRequest(ctx(env, extra), `/athlete/${athleteId}/events/bulk`, {
        apiKey: api_key,
        method: "POST",
        params: { upsertOnUid: upsert_on_uid, updatePlanApplied: update_plan_applied },
        data: events,
      });
      if (isIntervalsError(result)) {
        return textResult(intervalError("Error creating bulk events", result));
      }
      const created = Array.isArray(result) ? result.length : 0;
      return textResult(`Successfully created/updated ${created} event(s).`);
    },
  );

  server.registerTool(
    "get_wellness_data",
    {
      description: "Get wellness data for an athlete from Intervals.icu",
      inputSchema: { athlete_id: z.string().optional(), api_key: z.string().optional(), start_date: z.string().optional(), end_date: z.string().optional() },
    },
    async ({ athlete_id, api_key, start_date, end_date }, extra) => {
      const athleteId = resolveAthleteIdForRequest(env, extra, athlete_id);
      const [start, end] = resolveDateRange(start_date, end_date);
      const result = await makeIntervalsRequest(ctx(env, extra), `/athlete/${athleteId}/wellness`, {
        apiKey: api_key,
        params: { oldest: start, newest: end },
      });
      if (isIntervalsError(result)) {
        return textResult(intervalError("Error fetching wellness data", result));
      }
      if (Array.isArray(result)) {
        return textResult(result.length ? summarizeCollection("Wellness Data", result, ["id", "date", "weight", "restingHR", "sleepSecs"]) : `No wellness data found for athlete ${athleteId} in the specified date range.`);
      }
      if (result && typeof result === "object") {
        return textResult(pretty(result));
      }
      return textResult(`No wellness data found for athlete ${athleteId} in the specified date range.`);
    },
  );

  server.registerTool(
    "get_custom_items",
    {
      description: "Get custom items for an athlete from Intervals.icu",
      inputSchema: { athlete_id: z.string().optional(), api_key: z.string().optional() },
    },
    async ({ athlete_id, api_key }, extra) => {
      const athleteId = resolveAthleteIdForRequest(env, extra, athlete_id);
      const result = await makeIntervalsRequest(ctx(env, extra), `/athlete/${athleteId}/custom-item`, { apiKey: api_key });
      if (isIntervalsError(result)) {
        return textResult(intervalError("Error fetching custom items", result));
      }
      const items = Array.isArray(result) ? result : [];
      return textResult(items.length ? summarizeCollection("Custom Items", items, ["id", "name", "type", "description"]) : `No custom items found for athlete ${athleteId}.`);
    },
  );

  server.registerTool(
    "get_custom_item_by_id",
    {
      description: "Get a specific custom item from Intervals.icu",
      inputSchema: { item_id: z.number().int(), athlete_id: z.string().optional(), api_key: z.string().optional() },
    },
    async ({ item_id, athlete_id, api_key }, extra) => {
      const athleteId = resolveAthleteIdForRequest(env, extra, athlete_id);
      const result = await makeIntervalsRequest(ctx(env, extra), `/athlete/${athleteId}/custom-item/${item_id}`, { apiKey: api_key });
      if (isIntervalsError(result)) {
        return textResult(intervalError("Error fetching custom item", result));
      }
      return textResult(result ? summarizeObject(result, ["id", "name", "type", "description", "visibility"]) : `No custom item found with ID ${item_id}.`);
    },
  );

  const customItemSchema = {
    athlete_id: z.string().optional(),
    api_key: z.string().optional(),
    name: z.string().optional(),
    item_type: z.string().optional(),
    description: z.string().optional(),
    content: z.record(z.string(), z.any()).or(z.string()).optional(),
    visibility: z.string().optional(),
  };

  server.registerTool(
    "create_custom_item",
    {
      description: "Create a custom item on Intervals.icu",
      inputSchema: {
        ...customItemSchema,
        name: z.string(),
        item_type: z.string(),
      },
    },
    async ({ name, item_type, athlete_id, api_key, description, content, visibility }, extra) => {
      const athleteId = resolveAthleteIdForRequest(env, extra, athlete_id);
      let parsedContent: unknown;
      if (typeof content === "string") {
        try {
          parsedContent = JSON.parse(content);
        } catch {
          return textResult("Error: content must be valid JSON.");
        }
      } else {
        parsedContent = content;
      }
      const result = await makeIntervalsRequest(ctx(env, extra), `/athlete/${athleteId}/custom-item`, {
        apiKey: api_key,
        method: "POST",
        data: { name, type: item_type, description, content: parsedContent, visibility },
      });
      if (isIntervalsError(result)) {
        return textResult(intervalError("Error creating custom item", result));
      }
      return textResult(`Successfully created custom item:\n\n${pretty(result)}`);
    },
  );

  server.registerTool(
    "update_custom_item",
    {
      description: "Update a custom item on Intervals.icu",
      inputSchema: {
        item_id: z.number().int(),
        ...customItemSchema,
      },
    },
    async ({ item_id, athlete_id, api_key, name, item_type, description, content, visibility }, extra) => {
      const athleteId = resolveAthleteIdForRequest(env, extra, athlete_id);
      let parsedContent: unknown;
      if (typeof content === "string") {
        try {
          parsedContent = JSON.parse(content);
        } catch {
          return textResult("Error: content must be valid JSON.");
        }
      } else {
        parsedContent = content;
      }
      const result = await makeIntervalsRequest(ctx(env, extra), `/athlete/${athleteId}/custom-item/${item_id}`, {
        apiKey: api_key,
        method: "PUT",
        data: { name, type: item_type, description, content: parsedContent, visibility },
      });
      if (isIntervalsError(result)) {
        return textResult(intervalError("Error updating custom item", result));
      }
      return textResult(`Successfully updated custom item:\n\n${pretty(result)}`);
    },
  );

  server.registerTool(
    "delete_custom_item",
    {
      description: "Delete a custom item from Intervals.icu",
      inputSchema: { item_id: z.number().int(), athlete_id: z.string().optional(), api_key: z.string().optional() },
    },
    async ({ item_id, athlete_id, api_key }, extra) => {
      const athleteId = resolveAthleteIdForRequest(env, extra, athlete_id);
      const result = await makeIntervalsRequest(ctx(env, extra), `/athlete/${athleteId}/custom-item/${item_id}`, { apiKey: api_key, method: "DELETE" });
      if (isIntervalsError(result)) {
        return textResult(intervalError("Error deleting custom item", result));
      }
      return textResult(`Successfully deleted custom item ${item_id}.`);
    },
  );

  server.registerTool(
    "get_athlete",
    {
      description: "Get athlete profile from Intervals.icu",
      inputSchema: { athlete_id: z.string().optional(), api_key: z.string().optional() },
    },
    async ({ athlete_id, api_key }, extra) => {
      const athleteId = resolveAthleteIdForRequest(env, extra, athlete_id);
      const result = await makeIntervalsRequest(ctx(env, extra), `/athlete/${athleteId}`, { apiKey: api_key });
      if (isIntervalsError(result)) {
        return textResult(intervalError("Error fetching athlete", result));
      }
      return textResult(result ? summarizeObject(result, ["id", "name", "email", "sex", "weight", "timezone"]) : "Unexpected response from API.");
    },
  );

  server.registerTool(
    "get_sport_settings",
    {
      description: "Get sport settings for an athlete",
      inputSchema: { athlete_id: z.string().optional(), sport_type: z.string().optional(), api_key: z.string().optional() },
    },
    async ({ athlete_id, sport_type, api_key }, extra) => {
      const athleteId = resolveAthleteIdForRequest(env, extra, athlete_id);
      const result = await makeIntervalsRequest(ctx(env, extra), `/athlete/${athleteId}/sport-settings${sport_type ? `/${sport_type}` : ""}`, { apiKey: api_key });
      if (isIntervalsError(result)) {
        return textResult(intervalError("Error fetching sport settings", result));
      }
      if (Array.isArray(result)) {
        return textResult(summarizeCollection("Sport settings", result, ["type", "ftp", "lthr", "max_hr"]));
      }
      return textResult(result ? summarizeObject(result, ["type", "ftp", "lthr", "max_hr"]) : "No sport settings found.");
    },
  );

  server.registerTool(
    "get_training_plan",
    {
      description: "Get the athlete's current training plan",
      inputSchema: { athlete_id: z.string().optional(), api_key: z.string().optional() },
    },
    async ({ athlete_id, api_key }, extra) => {
      const athleteId = resolveAthleteIdForRequest(env, extra, athlete_id);
      const result = await makeIntervalsRequest(ctx(env, extra), `/athlete/${athleteId}/training-plan`, { apiKey: api_key });
      if (isIntervalsError(result)) {
        return textResult(intervalError("Error fetching training plan", result));
      }
      return textResult(result ? pretty(result) : "No training plan found.");
    },
  );

  server.registerTool(
    "search_activities",
    {
      description: "Search activities by name or tag",
      inputSchema: { athlete_id: z.string().optional(), q: z.string().optional(), limit: z.number().int().optional(), api_key: z.string().optional() },
    },
    async ({ athlete_id, q, limit, api_key }, extra) => {
      const athleteId = resolveAthleteIdForRequest(env, extra, athlete_id);
      const result = await makeIntervalsRequest(ctx(env, extra), `/athlete/${athleteId}/activities/search`, {
        apiKey: api_key,
        params: { q, limit },
      });
      if (isIntervalsError(result)) {
        return textResult(intervalError("Error searching activities", result));
      }
      const activities = Array.isArray(result) ? result : [];
      return textResult(activities.length ? summarizeCollection("Search results", activities, ["id", "name", "type", "start_date_local"]) : "No activities found.");
    },
  );

  server.registerTool(
    "search_intervals",
    {
      description: "Find activities containing matching intervals",
      inputSchema: {
        athlete_id: z.string().optional(),
        duration_seconds: z.number().int().optional(),
        intensity_min: z.number().optional(),
        intensity_max: z.number().optional(),
        interval_type: z.string().optional(),
        reps: z.number().int().optional(),
        limit: z.number().int().optional(),
        api_key: z.string().optional(),
      },
    },
    async ({ athlete_id, duration_seconds, intensity_min, intensity_max, interval_type, reps, limit, api_key }, extra) => {
      const athleteId = resolveAthleteIdForRequest(env, extra, athlete_id);
      const result = await makeIntervalsRequest(ctx(env, extra), `/athlete/${athleteId}/activities/interval-search`, {
        apiKey: api_key,
        params: {
          duration: duration_seconds,
          intensityMin: intensity_min,
          intensityMax: intensity_max,
          type: interval_type,
          reps,
          limit,
        },
      });
      if (isIntervalsError(result)) {
        return textResult(intervalError("Error searching intervals", result));
      }
      const activities = Array.isArray(result) ? result : [];
      return textResult(activities.length ? summarizeCollection("Interval search results", activities, ["id", "name", "type", "start_date_local"]) : "No activities found with matching intervals.");
    },
  );

  server.registerTool(
    "list_workouts",
    {
      description: "List workouts in the athlete library",
      inputSchema: { athlete_id: z.string().optional(), api_key: z.string().optional() },
    },
    async ({ athlete_id, api_key }, extra) => {
      const athleteId = resolveAthleteIdForRequest(env, extra, athlete_id);
      const result = await makeIntervalsRequest(ctx(env, extra), `/athlete/${athleteId}/workouts`, { apiKey: api_key });
      if (isIntervalsError(result)) {
        return textResult(intervalError("Error listing workouts", result));
      }
      const workouts = Array.isArray(result) ? result : [];
      return textResult(workouts.length ? summarizeCollection("Workout library", workouts, ["id", "name", "sport", "folder"]) : "No workouts in library.");
    },
  );

  server.registerTool(
    "list_folders",
    {
      description: "List workout folders",
      inputSchema: { athlete_id: z.string().optional(), api_key: z.string().optional() },
    },
    async ({ athlete_id, api_key }, extra) => {
      const athleteId = resolveAthleteIdForRequest(env, extra, athlete_id);
      const result = await makeIntervalsRequest(ctx(env, extra), `/athlete/${athleteId}/folders`, { apiKey: api_key });
      if (isIntervalsError(result)) {
        return textResult(intervalError("Error listing folders", result));
      }
      const folders = Array.isArray(result) ? result : [];
      return textResult(folders.length ? summarizeCollection("Folders", folders, ["id", "name", "children"]) : "No folders found.");
    },
  );

  server.registerTool(
    "create_bulk_workouts",
    {
      description: "Create multiple workouts at once in the athlete library",
      inputSchema: { athlete_id: z.string().optional(), workouts: z.array(z.record(z.string(), z.any())), api_key: z.string().optional() },
    },
    async ({ athlete_id, workouts, api_key }, extra) => {
      const athleteId = resolveAthleteIdForRequest(env, extra, athlete_id);
      const result = await makeIntervalsRequest(ctx(env, extra), `/athlete/${athleteId}/workouts/bulk`, {
        apiKey: api_key,
        method: "POST",
        data: workouts,
      });
      if (isIntervalsError(result)) {
        return textResult(intervalError("Error creating bulk workouts", result));
      }
      return textResult(`Successfully created ${Array.isArray(result) ? result.length : 0} workout(s).`);
    },
  );

  server.registerTool(
    "list_seasons",
    {
      description: "List training seasons for an athlete",
      inputSchema: { athlete_id: z.string().optional(), api_key: z.string().optional(), start_date: z.string().optional(), end_date: z.string().optional() },
    },
    async ({ athlete_id, api_key, start_date, end_date }, extra) => {
      const athleteId = resolveAthleteIdForRequest(env, extra, athlete_id);
      const start = start_date ?? daysFromNow(-365);
      const end = end_date ?? daysFromNow(365);
      const result = await makeIntervalsRequest(ctx(env, extra), `/athlete/${athleteId}/events`, {
        apiKey: api_key,
        params: { oldest: start, newest: end, category: "SEASON_START" },
      });
      if (isIntervalsError(result)) {
        return textResult(intervalError("Error fetching seasons", result));
      }
      const seasons = Array.isArray(result) ? result : [];
      return textResult(seasons.length ? summarizeCollection("Seasons", seasons, ["id", "name", "category", "start_date_local", "end_date_local"]) : `No seasons found for athlete ${athleteId} in the specified date range.`);
    },
  );

  server.registerTool(
    "create_season",
    {
      description: "Create a new training season",
      inputSchema: {
        name: z.string(),
        start_date: z.string(),
        athlete_id: z.string().optional(),
        api_key: z.string().optional(),
        end_date: z.string().optional(),
        description: z.string().optional(),
        color: z.string().optional(),
      },
    },
    async ({ name, start_date, athlete_id, api_key, end_date, description, color }, extra) => {
      const athleteId = resolveAthleteIdForRequest(env, extra, athlete_id);
      const result = await makeIntervalsRequest(ctx(env, extra), `/athlete/${athleteId}/events`, {
        apiKey: api_key,
        method: "POST",
        data: {
          start_date_local: `${start_date}T00:00:00`,
          end_date_local: end_date ? `${end_date}T00:00:00` : undefined,
          category: "SEASON_START",
          name,
          description,
          color,
        },
      });
      if (isIntervalsError(result)) {
        return textResult(intervalError("Error creating season", result));
      }
      return textResult(`Season created successfully:\n\n${pretty(result)}`);
    },
  );

  server.registerTool(
    "update_season",
    {
      description: "Update an existing training season",
      inputSchema: {
        event_id: z.string(),
        athlete_id: z.string().optional(),
        api_key: z.string().optional(),
        name: z.string().optional(),
        start_date: z.string().optional(),
        end_date: z.string().optional(),
        description: z.string().optional(),
        color: z.string().optional(),
      },
    },
    async ({ event_id, athlete_id, api_key, name, start_date, end_date, description, color }, extra) => {
      const athleteId = resolveAthleteIdForRequest(env, extra, athlete_id);
      const result = await makeIntervalsRequest(ctx(env, extra), `/athlete/${athleteId}/events/${event_id}`, {
        apiKey: api_key,
        method: "PUT",
        data: {
          category: "SEASON_START",
          name,
          start_date_local: start_date ? `${start_date}T00:00:00` : undefined,
          end_date_local: end_date ? `${end_date}T00:00:00` : undefined,
          description,
          color,
        },
      });
      if (isIntervalsError(result)) {
        return textResult(intervalError("Error updating season", result));
      }
      return textResult(`Season updated successfully:\n\n${pretty(result)}`);
    },
  );

  server.registerTool(
    "get_intervals_credentials_status",
    { description: "Return whether the authenticated user has configured Intervals.icu credentials." },
    async (extra) => {
      const credentials = withResolvedCredentials(env, extra);
      if (!credentials.userId) {
        return textResult("Credential management requires authenticated MCP access.");
      }
      return textResult(
        credentials.athleteId && credentials.apiKey
          ? `Intervals.icu credentials are configured for athlete ${credentials.athleteId}.`
          : "Intervals.icu credentials are not configured for your account.",
      );
    },
  );

  server.registerTool(
    "set_intervals_credentials",
    {
      description: "Store or update the authenticated user's Intervals.icu credentials.",
      inputSchema: { athlete_id: z.string().trim().min(1), api_key: z.string() },
    },
    async ({ athlete_id, api_key }, extra) => {
      const credentials = withResolvedCredentials(env, extra);
      if (!credentials.userId) {
        return textResult("Credential management requires authenticated MCP access.");
      }
      const trimmedAthleteId = athlete_id.trim();
      validateAthleteId(trimmedAthleteId);
      const trimmedApiKey = api_key.trim();
      if (!trimmedApiKey) {
        return textResult("Error: api_key must not be empty.");
      }
      await repositoryFactory().setIntervalsCredentials(credentials.userId, {
        athleteId: trimmedAthleteId,
        apiKey: trimmedApiKey,
      });
      return textResult(`Saved Intervals.icu credentials for athlete ${trimmedAthleteId}.`);
    },
  );

  server.registerTool(
    "clear_intervals_credentials",
    { description: "Delete the authenticated user's stored Intervals.icu credentials." },
    async (extra) => {
      const credentials = withResolvedCredentials(env, extra);
      if (!credentials.userId) {
        return textResult("Credential management requires authenticated MCP access.");
      }
      await repositoryFactory().clearIntervalsCredentials(credentials.userId);
      return textResult("Cleared your stored Intervals.icu credentials.");
    },
  );
}
