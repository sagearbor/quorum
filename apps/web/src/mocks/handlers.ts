import { http, HttpResponse } from "msw";
import type {
  CreateEventRequest,
  CreateEventResponse,
  CreateQuorumRequest,
  CreateQuorumResponse,
} from "@quorum/types";
import {
  mockEvent,
  mockQuorums,
  mockRolesByQuorum,
  mockActiveRoles,
  mockContributions,
} from "../lib/mockData";

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

let eventCounter = 0;
let quorumCounter = 0;

export const handlers = [
  // GET /events/:slug
  http.get(`${API_BASE}/events/:slug`, ({ params }) => {
    if (params.slug === mockEvent.slug) {
      return HttpResponse.json(mockEvent);
    }
    return new HttpResponse(null, { status: 404 });
  }),

  // GET /events/:eventId/quorums
  http.get(`${API_BASE}/events/:eventId/quorums`, ({ params }) => {
    if (params.eventId === mockEvent.id) {
      return HttpResponse.json(mockQuorums);
    }
    return HttpResponse.json([]);
  }),

  // GET /quorums/:quorumId/state
  http.get(`${API_BASE}/quorums/:quorumId/state`, ({ params }) => {
    const qid = params.quorumId as string;
    const quorum = mockQuorums.find((q) => q.id === qid);
    if (!quorum) {
      return new HttpResponse(null, { status: 404 });
    }

    return HttpResponse.json({
      quorum,
      contributions: mockContributions.filter((c) => c.quorum_id === qid),
      artifact: null,
      health_score: quorum.heat_score,
      active_roles: mockActiveRoles[qid] ?? [],
    });
  }),

  // GET /quorums/:quorumId/roles
  http.get(`${API_BASE}/quorums/:quorumId/roles`, ({ params }) => {
    const qid = params.quorumId as string;
    return HttpResponse.json(mockRolesByQuorum[qid] ?? []);
  }),

  // POST /quorums/:quorumId/contribute
  // Returns the extended agent-system response shape including facilitator_reply.
  http.post(`${API_BASE}/quorums/:quorumId/contribute`, async ({ request }) => {
    const body = (await request.json()) as Record<string, unknown>;
    void body;
    return HttpResponse.json(
      {
        contribution_id: `c-${Date.now()}`,
        tier_processed: 1,
        facilitator_reply: "Contribution received. I'll incorporate your perspective into the quorum analysis.",
        facilitator_message_id: `msg-${Date.now()}`,
        facilitator_tags: ["contribution", "analysis"],
        a2a_requests_triggered: 0,
      },
      { status: 201 }
    );
  }),

  // POST /events (typed — stream-i)
  http.post<never, CreateEventRequest>(`${API_BASE}/events`, async ({ request }) => {
    const body = await request.json();
    eventCounter++;
    const response: CreateEventResponse = {
      id: `evt-${String(eventCounter).padStart(3, "0")}`,
      slug: body.slug,
      created_at: new Date().toISOString(),
    };
    return HttpResponse.json(response, { status: 201 });
  }),

  // POST /events/:event_id/quorums (typed — stream-i)
  http.post<{ event_id: string }, CreateQuorumRequest>(
    `${API_BASE}/events/:event_id/quorums`,
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

  // POST /quorums/:quorumId/resolve
  http.post(`${API_BASE}/quorums/:quorumId/resolve`, async () => {
    return HttpResponse.json({
      artifact_id: `art-${Date.now()}`,
      download_url: "#",
    });
  }),

  // GET /quorums/:quorumId/stations/:stationId/messages
  http.get(
    `${API_BASE}/quorums/:quorumId/stations/:stationId/messages`,
    () => {
      return HttpResponse.json({ messages: [] });
    }
  ),

  // POST /quorums/:quorumId/stations/:stationId/ask
  http.post(
    `${API_BASE}/quorums/:quorumId/stations/:stationId/ask`,
    async ({ request }) => {
      const body = (await request.json()) as { content: string };
      return HttpResponse.json({
        reply: `Facilitator response to: "${body.content}"`,
        message_id: `msg-${Date.now()}`,
        tags: ["test"],
      });
    }
  ),

  // GET /quorums/:quorumId/documents
  http.get(`${API_BASE}/quorums/:quorumId/documents`, () => {
    return HttpResponse.json({ documents: [] });
  }),

  // GET /quorums/:quorumId/a2a/requests
  http.get(`${API_BASE}/quorums/:quorumId/a2a/requests`, () => {
    return HttpResponse.json({ requests: [] });
  }),

  // POST /quorums/:quorumId/a2a/request
  http.post(`${API_BASE}/quorums/:quorumId/a2a/request`, async () => {
    return HttpResponse.json(
      { request_id: `a2a-${Date.now()}`, target_response: null },
      { status: 201 }
    );
  }),

  // PATCH /quorums/:quorumId/a2a/requests/:requestId
  http.patch(
    `${API_BASE}/quorums/:quorumId/a2a/requests/:requestId`,
    async () => {
      return HttpResponse.json({ updated: true });
    }
  ),
];
