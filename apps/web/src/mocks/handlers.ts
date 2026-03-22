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
  http.post(`${API_BASE}/quorums/:quorumId/contribute`, async ({ request }) => {
    const body = (await request.json()) as Record<string, unknown>;
    void body;
    return HttpResponse.json(
      {
        contribution_id: `c-${Date.now()}`,
        tier_processed: 1,
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

  // POST /events/:event_id/architect/generate-roles
  http.post(
    `${API_BASE}/events/:event_id/architect/generate-roles`,
    async () => {
      return HttpResponse.json({
        roles: [
          {
            name: "Researcher",
            description: "Domain expert for evidence quality",
            authority_rank: 3,
            capacity: "unlimited",
            suggested_prompt_focus: "Evaluate evidence base",
          },
          {
            name: "Ethicist",
            description: "Ethics specialist for regulatory standards",
            authority_rank: 4,
            capacity: 1,
            suggested_prompt_focus: "Identify ethical implications",
          },
          {
            name: "Administrator",
            description: "Operations lead for resources",
            authority_rank: 2,
            capacity: 1,
            suggested_prompt_focus: "Assess resource requirements",
          },
          {
            name: "Patient Advocate",
            description: "Representative for participant welfare",
            authority_rank: 5,
            capacity: "unlimited",
            suggested_prompt_focus: "Champion participant safety",
          },
        ],
        problem_summary: "Test problem description",
      });
    }
  ),

  // POST /events/:event_id/architect/ai-start
  http.post(
    `${API_BASE}/events/:event_id/architect/ai-start`,
    async ({ params }) => {
      return HttpResponse.json({
        quorum_id: `q-ai-${Date.now()}`,
        share_url: `/event/${params.event_id}/quorum/q-ai-001`,
        mode: "approved",
      });
    }
  ),

  // POST /quorums/:quorumId/architect/guidance
  http.post(
    `${API_BASE}/quorums/:quorumId/architect/guidance`,
    async ({ params }) => {
      return HttpResponse.json({
        quorum_id: params.quorumId,
        deliveries: [
          { role_id: "role-1", delivery: "supabase_fallback", status: "stored" },
        ],
      });
    }
  ),
];
