import { http, HttpResponse } from "msw";
import {
  mockEvent,
  mockQuorums,
  mockRolesByQuorum,
  mockActiveRoles,
  mockContributions,
} from "../lib/mockData";

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

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
    return HttpResponse.json(
      {
        contribution_id: `c-${Date.now()}`,
        tier_processed: 1,
      },
      { status: 201 }
    );
  }),

  // POST /events
  http.post(`${API_BASE}/events`, async ({ request }) => {
    const body = (await request.json()) as Record<string, unknown>;
    return HttpResponse.json(
      {
        id: `evt-${Date.now()}`,
        slug: body.slug,
        created_at: new Date().toISOString(),
      },
      { status: 201 }
    );
  }),

  // POST /events/:eventId/quorums
  http.post(`${API_BASE}/events/:eventId/quorums`, async () => {
    return HttpResponse.json(
      {
        id: `q-${Date.now()}`,
        status: "open",
        share_url: `http://localhost:3000/event/mock-event/quorum/q-${Date.now()}`,
      },
      { status: 201 }
    );
  }),

  // POST /quorums/:quorumId/resolve
  http.post(`${API_BASE}/quorums/:quorumId/resolve`, async () => {
    return HttpResponse.json({
      artifact_id: `art-${Date.now()}`,
      download_url: "#",
    });
  }),
];
