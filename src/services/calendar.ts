import { DAVClient, type DAVCalendar, type DAVCalendarObject } from "tsdav";

import { getRequiredConfigValue, type AppConfig } from "./auth.js";

export interface CalendarTimeRange {
  start: string;
  end: string;
}

function normalizeUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

function urlsEqual(left: string, right: string): boolean {
  return normalizeUrl(left) === normalizeUrl(right);
}

export class ForwardEmailCalendarService {
  private readonly config: AppConfig;

  constructor(config: AppConfig) {
    this.config = config;
  }

  private async loginClient(): Promise<DAVClient> {
    const client = new DAVClient({
      serverUrl: getRequiredConfigValue(this.config, "FE_CALDAV_URL"),
      credentials: {
        username: getRequiredConfigValue(this.config, "FE_ALIAS_USER"),
        password: getRequiredConfigValue(this.config, "FE_ALIAS_PASS")
      },
      authMethod: "Basic",
      defaultAccountType: "caldav"
    });

    await client.login();
    return client;
  }

  private async findCalendar(client: DAVClient, calendarUrl: string): Promise<DAVCalendar> {
    const calendars = await client.fetchCalendars();
    const calendar = calendars.find((item) => urlsEqual(item.url, calendarUrl));

    if (!calendar) {
      throw new Error(`Calendar not found: ${calendarUrl}`);
    }

    return calendar;
  }

  private async getEventWithCalendar(
    client: DAVClient,
    calendar: DAVCalendar,
    eventUrl: string
  ): Promise<DAVCalendarObject> {
    const events = (await client.fetchCalendarObjects({
      calendar,
      objectUrls: [eventUrl]
    })) as DAVCalendarObject[];

    const event = events.find((item) => urlsEqual(item.url, eventUrl));
    if (!event) {
      throw new Error(`Event not found: ${eventUrl}`);
    }

    return event;
  }

  public async listCalendars(): Promise<DAVCalendar[]> {
    const client = await this.loginClient();
    return client.fetchCalendars();
  }

  public async listEvents(
    calendarUrl: string,
    timeRange?: CalendarTimeRange
  ): Promise<DAVCalendarObject[]> {
    const client = await this.loginClient();
    const calendar = await this.findCalendar(client, calendarUrl);

    return (await client.fetchCalendarObjects({
      calendar,
      timeRange
    })) as DAVCalendarObject[];
  }

  public async getEvent(calendarUrl: string, eventUrl: string): Promise<DAVCalendarObject> {
    const client = await this.loginClient();
    const calendar = await this.findCalendar(client, calendarUrl);
    return this.getEventWithCalendar(client, calendar, eventUrl);
  }

  public async createEvent(
    calendarUrl: string,
    iCalData: string
  ): Promise<{ eventUrl: string; etag: string | null; status: number; statusText: string }> {
    const client = await this.loginClient();
    const calendar = await this.findCalendar(client, calendarUrl);
    const filename = `${globalThis.crypto.randomUUID()}.ics`;
    const response = await client.createCalendarObject({
      calendar,
      iCalString: iCalData,
      filename
    });

    return {
      eventUrl: new URL(filename, calendar.url).href,
      etag: response.headers.get("etag"),
      status: response.status,
      statusText: response.statusText
    };
  }

  public async updateEvent(
    calendarUrl: string,
    eventUrl: string,
    iCalData: string
  ): Promise<{ eventUrl: string; etag: string | null; status: number; statusText: string }> {
    const client = await this.loginClient();
    const calendar = await this.findCalendar(client, calendarUrl);
    const currentEvent = await this.getEventWithCalendar(client, calendar, eventUrl);
    const response = await client.updateCalendarObject({
      calendarObject: {
        ...currentEvent,
        data: iCalData
      }
    });

    return {
      eventUrl: currentEvent.url,
      etag: response.headers.get("etag") ?? currentEvent.etag ?? null,
      status: response.status,
      statusText: response.statusText
    };
  }
}

export async function listCalendars(config: AppConfig): Promise<DAVCalendar[]> {
  return new ForwardEmailCalendarService(config).listCalendars();
}

export async function listEvents(
  config: AppConfig,
  calendarUrl: string,
  timeRange?: CalendarTimeRange
): Promise<DAVCalendarObject[]> {
  return new ForwardEmailCalendarService(config).listEvents(calendarUrl, timeRange);
}

export async function getEvent(
  config: AppConfig,
  calendarUrl: string,
  eventUrl: string
): Promise<DAVCalendarObject> {
  return new ForwardEmailCalendarService(config).getEvent(calendarUrl, eventUrl);
}

export async function createEvent(
  config: AppConfig,
  calendarUrl: string,
  iCalData: string
): Promise<{ eventUrl: string; etag: string | null; status: number; statusText: string }> {
  return new ForwardEmailCalendarService(config).createEvent(calendarUrl, iCalData);
}

export async function updateEvent(
  config: AppConfig,
  calendarUrl: string,
  eventUrl: string,
  iCalData: string
): Promise<{ eventUrl: string; etag: string | null; status: number; statusText: string }> {
  return new ForwardEmailCalendarService(config).updateEvent(calendarUrl, eventUrl, iCalData);
}
