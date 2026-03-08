import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { ForwardEmailCalendarService } from "../services/calendar.js";

function toPrettyText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  return JSON.stringify(value, null, 2);
}

function toolResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: toPrettyText(value) }]
  };
}

function toolError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    isError: true,
    content: [{ type: "text" as const, text: message }]
  };
}

function parseDate(value: string, fieldName: string): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid ${fieldName}: "${value}". Use an ISO-8601 date/time string.`);
  }

  return parsed;
}

function toIcsDateTime(value: string, fieldName: string): string {
  const parsed = parseDate(value, fieldName);
  return parsed.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function escapeIcsText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\r?\n/g, "\\n")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");
}

function buildEventIcs(params: {
  summary: string;
  dtstart: string;
  dtend: string;
  description?: string;
}): string {
  const start = parseDate(params.dtstart, "dtstart");
  const end = parseDate(params.dtend, "dtend");
  if (start >= end) {
    throw new Error("dtend must be later than dtstart.");
  }

  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Forward Email MCP//Calendar Tool//EN",
    "BEGIN:VEVENT",
    `UID:${globalThis.crypto.randomUUID()}@forwardemail-mcp`,
    `DTSTAMP:${toIcsDateTime(new Date().toISOString(), "dtstamp")}`,
    `SUMMARY:${escapeIcsText(params.summary)}`,
    `DTSTART:${toIcsDateTime(params.dtstart, "dtstart")}`,
    `DTEND:${toIcsDateTime(params.dtend, "dtend")}`,
    ...(params.description ? [`DESCRIPTION:${escapeIcsText(params.description)}`] : []),
    "END:VEVENT",
    "END:VCALENDAR",
    ""
  ];

  return lines.join("\r\n");
}

function upsertEventProperty(iCalData: string, propertyName: string, value: string): string {
  const lines = iCalData.split(/\r?\n/);
  const eventStart = lines.findIndex((line) => line.trim().toUpperCase() === "BEGIN:VEVENT");
  const eventEnd = lines.findIndex(
    (line, index) => index > eventStart && line.trim().toUpperCase() === "END:VEVENT"
  );

  if (eventStart < 0 || eventEnd < 0) {
    throw new Error("Invalid iCalendar payload: missing VEVENT block.");
  }

  const propertyMatcher = new RegExp(`^${propertyName}(;[^:]*)?:`, "i");
  const existingProperty = lines.findIndex(
    (line, index) => index > eventStart && index < eventEnd && propertyMatcher.test(line)
  );
  const newLine = `${propertyName}:${value}`;

  if (existingProperty >= 0) {
    lines[existingProperty] = newLine;
  } else {
    lines.splice(eventEnd, 0, newLine);
  }

  return lines.join("\r\n");
}

export function registerCalendarTools(
  server: McpServer,
  service: ForwardEmailCalendarService
): void {
  server.registerTool(
    "calendar_list_calendars",
    {
      description: "List CalDAV calendars.",
      inputSchema: {}
    },
    async () => {
      try {
        const data = await service.listCalendars();
        return toolResult(data);
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "calendar_list_events",
    {
      description: "List events for a calendar with an optional time range.",
      inputSchema: {
        calendarUrl: z.string().min(1),
        startDate: z.string().optional(),
        endDate: z.string().optional()
      }
    },
    async (input) => {
      try {
        if ((input.startDate && !input.endDate) || (!input.startDate && input.endDate)) {
          throw new Error("Provide both startDate and endDate together.");
        }

        const timeRange =
          input.startDate && input.endDate
            ? {
                start: parseDate(input.startDate, "startDate").toISOString(),
                end: parseDate(input.endDate, "endDate").toISOString()
              }
            : undefined;

        if (timeRange && new Date(timeRange.start) >= new Date(timeRange.end)) {
          throw new Error("endDate must be later than startDate.");
        }

        const data = await service.listEvents(input.calendarUrl, timeRange);
        return toolResult(data);
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "calendar_get_event",
    {
      description: "Fetch a single calendar event by URL.",
      inputSchema: {
        calendarUrl: z.string().min(1),
        eventUrl: z.string().min(1)
      }
    },
    async (input) => {
      try {
        const data = await service.getEvent(input.calendarUrl, input.eventUrl);
        return toolResult(data);
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "calendar_create_event",
    {
      description: "Create a calendar event from summary/date fields.",
      inputSchema: {
        calendarUrl: z.string().min(1),
        summary: z.string().min(1),
        dtstart: z.string().min(1),
        dtend: z.string().min(1),
        description: z.string().optional()
      }
    },
    async (input) => {
      try {
        const iCalData = buildEventIcs({
          summary: input.summary,
          dtstart: input.dtstart,
          dtend: input.dtend,
          description: input.description
        });

        const data = await service.createEvent(input.calendarUrl, iCalData);
        return toolResult(data);
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "calendar_update_event",
    {
      description: "Update selected event fields (summary/time/description).",
      inputSchema: {
        calendarUrl: z.string().min(1),
        eventUrl: z.string().min(1),
        summary: z.string().optional(),
        dtstart: z.string().optional(),
        dtend: z.string().optional(),
        description: z.string().optional()
      }
    },
    async (input) => {
      try {
        if (!input.summary && !input.dtstart && !input.dtend && !input.description) {
          throw new Error(
            "calendar_update_event requires at least one of summary, dtstart, dtend, description."
          );
        }
        if (input.dtstart && input.dtend) {
          const start = parseDate(input.dtstart, "dtstart");
          const end = parseDate(input.dtend, "dtend");
          if (start >= end) {
            throw new Error("dtend must be later than dtstart.");
          }
        }

        const currentEvent = await service.getEvent(input.calendarUrl, input.eventUrl);
        const currentIcalData =
          typeof currentEvent.data === "string" ? currentEvent.data : String(currentEvent.data ?? "");

        if (!currentIcalData.trim()) {
          throw new Error("Existing event data is empty; cannot update event.");
        }

        let nextIcalData = currentIcalData;
        if (input.summary) {
          nextIcalData = upsertEventProperty(nextIcalData, "SUMMARY", escapeIcsText(input.summary));
        }
        if (input.dtstart) {
          nextIcalData = upsertEventProperty(
            nextIcalData,
            "DTSTART",
            toIcsDateTime(input.dtstart, "dtstart")
          );
        }
        if (input.dtend) {
          nextIcalData = upsertEventProperty(
            nextIcalData,
            "DTEND",
            toIcsDateTime(input.dtend, "dtend")
          );
        }
        if (input.description !== undefined) {
          nextIcalData = upsertEventProperty(
            nextIcalData,
            "DESCRIPTION",
            escapeIcsText(input.description)
          );
        }

        nextIcalData = upsertEventProperty(
          nextIcalData,
          "DTSTAMP",
          toIcsDateTime(new Date().toISOString(), "dtstamp")
        );

        const data = await service.updateEvent(input.calendarUrl, input.eventUrl, nextIcalData);
        return toolResult(data);
      } catch (error) {
        return toolError(error);
      }
    }
  );
}
