import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { ForwardEmailContactsService } from "../services/contacts.js";

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

function escapeVCardText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\r?\n/g, "\\n")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");
}

function buildVCard(params: { fn: string; email?: string; tel?: string; note?: string }): string {
  const escapedFn = escapeVCardText(params.fn);

  const lines = [
    "BEGIN:VCARD",
    "VERSION:3.0",
    `FN:${escapedFn}`,
    `N:;${escapedFn};;;`,
    ...(params.email ? [`EMAIL;TYPE=INTERNET:${escapeVCardText(params.email)}`] : []),
    ...(params.tel ? [`TEL;TYPE=CELL:${escapeVCardText(params.tel)}`] : []),
    ...(params.note ? [`NOTE:${escapeVCardText(params.note)}`] : []),
    "END:VCARD",
    ""
  ];

  return lines.join("\r\n");
}

export function registerContactsTools(
  server: McpServer,
  service: ForwardEmailContactsService
): void {
  server.registerTool(
    "contacts_list",
    {
      description: "List contacts from one address book or all address books.",
      inputSchema: {
        addressBookUrl: z.string().min(1).optional()
      }
    },
    async (input) => {
      try {
        if (input.addressBookUrl) {
          const contacts = await service.listContacts(input.addressBookUrl);
          return toolResult({
            addressBookUrl: input.addressBookUrl,
            contacts
          });
        }

        const addressBooks = await service.listAddressBooks();
        const results = await Promise.all(
          addressBooks.map(async (addressBook) => ({
            addressBookUrl: addressBook.url,
            addressBookName: addressBook.displayName ?? "",
            contacts: await service.listContacts(addressBook.url)
          }))
        );

        return toolResult({ addressBooks: results });
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "contacts_search",
    {
      description: "Search contacts by name/email/phone in one or all address books.",
      inputSchema: {
        query: z.string().min(1),
        addressBookUrl: z.string().min(1).optional()
      }
    },
    async (input) => {
      try {
        if (input.addressBookUrl) {
          const contacts = await service.searchContacts(input.addressBookUrl, input.query);
          return toolResult({
            addressBookUrl: input.addressBookUrl,
            query: input.query,
            contacts
          });
        }

        const addressBooks = await service.listAddressBooks();
        const results = await Promise.all(
          addressBooks.map(async (addressBook) => ({
            addressBookUrl: addressBook.url,
            addressBookName: addressBook.displayName ?? "",
            contacts: await service.searchContacts(addressBook.url, input.query)
          }))
        );

        return toolResult({
          query: input.query,
          addressBooks: results
        });
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "contacts_get",
    {
      description: "Get one contact from an address book by contact URL.",
      inputSchema: {
        addressBookUrl: z.string().min(1),
        contactUrl: z.string().min(1)
      }
    },
    async (input) => {
      try {
        const data = await service.getContact(input.addressBookUrl, input.contactUrl);
        return toolResult(data);
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "contacts_create",
    {
      description: "Create a contact in an address book (CardDAV PUT vCard).",
      inputSchema: {
        addressBookUrl: z.string().min(1),
        fn: z.string().min(1),
        email: z.string().optional(),
        tel: z.string().optional(),
        note: z.string().optional()
      }
    },
    async (input) => {
      try {
        const vCardData = buildVCard({
          fn: input.fn,
          email: input.email,
          tel: input.tel,
          note: input.note
        });
        const data = await service.createContact(input.addressBookUrl, vCardData);
        return toolResult(data);
      } catch (error) {
        return toolError(error);
      }
    }
  );
}
