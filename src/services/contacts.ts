import { DAVClient, type DAVAddressBook, type DAVVCard } from "tsdav";

import { getRequiredConfigValue, type AppConfig } from "./auth.js";

function normalizeUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

function urlsEqual(left: string, right: string): boolean {
  return normalizeUrl(left) === normalizeUrl(right);
}

function unfoldVCardLines(vCardData: string): string[] {
  const lines = vCardData.split(/\r?\n/);
  const unfolded: string[] = [];

  for (const line of lines) {
    if ((line.startsWith(" ") || line.startsWith("\t")) && unfolded.length > 0) {
      unfolded[unfolded.length - 1] += line.slice(1);
      continue;
    }

    unfolded.push(line);
  }

  return unfolded;
}

function getVCardSearchableText(vCardData: string): string {
  const fields: string[] = [];
  const lines = unfoldVCardLines(vCardData);

  for (const line of lines) {
    const separatorIndex = line.indexOf(":");
    if (separatorIndex < 0) {
      continue;
    }

    const rawKey = line.slice(0, separatorIndex);
    const key = rawKey.split(";")[0]?.toUpperCase();
    if (key === "FN" || key === "EMAIL" || key === "TEL") {
      fields.push(line.slice(separatorIndex + 1));
    }
  }

  return fields.join("\n").toLowerCase();
}

export class ForwardEmailContactsService {
  private readonly config: AppConfig;

  constructor(config: AppConfig) {
    this.config = config;
  }

  private async loginClient(): Promise<DAVClient> {
    const client = new DAVClient({
      serverUrl: getRequiredConfigValue(this.config, "FE_CARDDAV_URL"),
      credentials: {
        username: getRequiredConfigValue(this.config, "FE_ALIAS_USER"),
        password: getRequiredConfigValue(this.config, "FE_ALIAS_PASS")
      },
      authMethod: "Basic",
      defaultAccountType: "carddav"
    });

    await client.login();
    return client;
  }

  private async findAddressBook(client: DAVClient, addressBookUrl: string): Promise<DAVAddressBook> {
    const addressBooks = await client.fetchAddressBooks();
    const addressBook = addressBooks.find((item) => urlsEqual(item.url, addressBookUrl));

    if (!addressBook) {
      throw new Error(`Address book not found: ${addressBookUrl}`);
    }

    return addressBook;
  }

  private async getContactWithAddressBook(
    client: DAVClient,
    addressBook: DAVAddressBook,
    contactUrl: string
  ): Promise<DAVVCard> {
    const contacts = (await client.fetchVCards({
      addressBook,
      objectUrls: [contactUrl]
    })) as DAVVCard[];

    const contact = contacts.find((item) => urlsEqual(item.url, contactUrl));
    if (!contact) {
      throw new Error(`Contact not found: ${contactUrl}`);
    }

    return contact;
  }

  public async listAddressBooks(): Promise<DAVAddressBook[]> {
    const client = await this.loginClient();
    return client.fetchAddressBooks();
  }

  public async listContacts(addressBookUrl: string): Promise<DAVVCard[]> {
    const client = await this.loginClient();
    const addressBook = await this.findAddressBook(client, addressBookUrl);
    return (await client.fetchVCards({ addressBook })) as DAVVCard[];
  }

  public async getContact(addressBookUrl: string, contactUrl: string): Promise<DAVVCard> {
    const client = await this.loginClient();
    const addressBook = await this.findAddressBook(client, addressBookUrl);
    return this.getContactWithAddressBook(client, addressBook, contactUrl);
  }

  public async searchContacts(addressBookUrl: string, query: string): Promise<DAVVCard[]> {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) {
      return [];
    }

    const contacts = await this.listContacts(addressBookUrl);
    return contacts.filter((contact) => {
      const data = typeof contact.data === "string" ? contact.data : String(contact.data ?? "");
      return getVCardSearchableText(data).includes(normalizedQuery);
    });
  }

  public async createContact(
    addressBookUrl: string,
    vCardData: string
  ): Promise<{ contactUrl: string; etag: string | null; status: number; statusText: string }> {
    const client = await this.loginClient();
    const addressBook = await this.findAddressBook(client, addressBookUrl);
    const filename = `${globalThis.crypto.randomUUID()}.vcf`;
    const response = await client.createVCard({
      addressBook,
      vCardString: vCardData,
      filename
    });

    return {
      contactUrl: new URL(filename, addressBook.url).href,
      etag: response.headers.get("etag"),
      status: response.status,
      statusText: response.statusText
    };
  }
}

export async function listAddressBooks(config: AppConfig): Promise<DAVAddressBook[]> {
  return new ForwardEmailContactsService(config).listAddressBooks();
}

export async function listContacts(config: AppConfig, addressBookUrl: string): Promise<DAVVCard[]> {
  return new ForwardEmailContactsService(config).listContacts(addressBookUrl);
}

export async function getContact(
  config: AppConfig,
  addressBookUrl: string,
  contactUrl: string
): Promise<DAVVCard> {
  return new ForwardEmailContactsService(config).getContact(addressBookUrl, contactUrl);
}

export async function searchContacts(
  config: AppConfig,
  addressBookUrl: string,
  query: string
): Promise<DAVVCard[]> {
  return new ForwardEmailContactsService(config).searchContacts(addressBookUrl, query);
}

export async function createContact(
  config: AppConfig,
  addressBookUrl: string,
  vCardData: string
): Promise<{ contactUrl: string; etag: string | null; status: number; statusText: string }> {
  return new ForwardEmailContactsService(config).createContact(addressBookUrl, vCardData);
}
