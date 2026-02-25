import { http, HttpResponse } from "msw";
import type {
  CreateEventRequest,
  CreateEventResponse,
  CreateQuorumRequest,
  CreateQuorumResponse,
} from "@quorum/types";

let eventCounter = 0;
let quorumCounter = 0;

export const handlers = [
  http.post<never, CreateEventRequest>("/events", async ({ request }) => {
    const body = await request.json();
    eventCounter++;
    const response: CreateEventResponse = {
      id: `evt-${String(eventCounter).padStart(3, "0")}`,
      slug: body.slug,
      created_at: new Date().toISOString(),
    };
    return HttpResponse.json(response, { status: 201 });
  }),

  http.post<{ event_id: string }, CreateQuorumRequest>(
    "/events/:event_id/quorums",
    async ({ request, params }) => {
      const body = await request.json();
      quorumCounter++;
      const response: CreateQuorumResponse = {
        id: `q-${String(quorumCounter).padStart(3, "0")}`,
        status: "open",
        share_url: `/event/${params.event_id}`,
      };
      void body; // consumed for validation
      return HttpResponse.json(response, { status: 201 });
    }
  ),
];
