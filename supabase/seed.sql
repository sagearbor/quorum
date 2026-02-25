-- Quorum: Seed Data — Clinical Trial Anchor Quorum
-- Synthetic data with fake NCT number. Loaded at every new event to ensure
-- the expo always has a live, polished demo with the health chart already rising.

-- =============================================================================
-- FIXED UUIDs (deterministic for reproducibility and FK references)
-- =============================================================================

-- Event
-- id: 00000000-0000-0000-0000-000000000001
-- Quorum
-- id: 00000000-0000-0000-0000-000000000010
-- Roles
-- PI:               00000000-0000-0000-0000-000000000101
-- IRB Chair:        00000000-0000-0000-0000-000000000102
-- Sponsor Monitor:  00000000-0000-0000-0000-000000000103
-- Site Coordinator: 00000000-0000-0000-0000-000000000104
-- Patient Advocate: 00000000-0000-0000-0000-000000000105
-- Artifact
-- id: 00000000-0000-0000-0000-000000000201

-- =============================================================================
-- EVENT
-- =============================================================================

INSERT INTO events (id, name, slug, access_code, max_active_quorums, created_by, created_at)
VALUES (
    '00000000-0000-0000-0000-000000000001',
    'Duke Clinical Trial Expo 2026',
    'duke-expo-2026',
    'DUKE2026',
    5,
    'seed-architect',
    now() - interval '2 hours'
);

-- =============================================================================
-- QUORUM
-- =============================================================================

INSERT INTO quorums (id, event_id, title, description, status, heat_score, dashboard_types, carousel_mode, created_at)
VALUES (
    '00000000-0000-0000-0000-000000000010',
    '00000000-0000-0000-0000-000000000001',
    'Phase III Trial NCT-2026-FAKE-001 — Site Enrollment Rescue',
    'Multi-site Phase III cardiovascular outcomes trial (BEACON-CV) has stalled at 47% enrollment across 12 sites after 18 months. Three sites are below 20% target. Protocol amendment under consideration. IRB approval needed for revised consent language. Sponsor threatening to pull two underperforming sites.',
    'active',
    62.5,
    ARRAY['quorum_health_chart', 'authority_cascade_tree', 'decision_waterfall'],
    'multi-view',
    now() - interval '1 hour 45 minutes'
);

-- =============================================================================
-- ROLES
-- =============================================================================

INSERT INTO roles (id, quorum_id, name, capacity, authority_rank, prompt_template, fallback_chain, color) VALUES
(
    '00000000-0000-0000-0000-000000000101',
    '00000000-0000-0000-0000-000000000010',
    'Principal Investigator',
    '1',
    5,
    '[{"field_name": "clinical_assessment", "prompt": "What is your clinical assessment of the enrollment barrier?"}, {"field_name": "protocol_recommendation", "prompt": "What protocol amendments do you recommend?"}, {"field_name": "site_strategy", "prompt": "How should underperforming sites be managed?"}]'::jsonb,
    ARRAY['00000000-0000-0000-0000-000000000103']::uuid[],
    '#2563EB'
),
(
    '00000000-0000-0000-0000-000000000102',
    '00000000-0000-0000-0000-000000000010',
    'IRB Chair',
    '1',
    4,
    '[{"field_name": "regulatory_concerns", "prompt": "What regulatory or ethical concerns exist with the proposed changes?"}, {"field_name": "consent_assessment", "prompt": "Does the revised consent language meet requirements?"}, {"field_name": "conditional_approval", "prompt": "Under what conditions would you approve the amendment?"}]'::jsonb,
    NULL,
    '#DC2626'
),
(
    '00000000-0000-0000-0000-000000000103',
    '00000000-0000-0000-0000-000000000010',
    'Sponsor Medical Monitor',
    '1',
    3,
    '[{"field_name": "risk_assessment", "prompt": "What is the sponsor risk assessment for continued enrollment?"}, {"field_name": "resource_commitment", "prompt": "What resources can the sponsor commit to rescue?"}, {"field_name": "timeline_constraint", "prompt": "What is the hard deadline for enrollment recovery?"}]'::jsonb,
    NULL,
    '#7C3AED'
),
(
    '00000000-0000-0000-0000-000000000104',
    '00000000-0000-0000-0000-000000000010',
    'Site Coordinator',
    'unlimited',
    2,
    '[{"field_name": "enrollment_barriers", "prompt": "What are the top barriers to enrollment at your site?"}, {"field_name": "patient_feedback", "prompt": "What feedback are patients giving about the trial?"}, {"field_name": "resource_needs", "prompt": "What resources would help improve enrollment?"}]'::jsonb,
    NULL,
    '#059669'
),
(
    '00000000-0000-0000-0000-000000000105',
    '00000000-0000-0000-0000-000000000010',
    'Patient Advocate',
    'unlimited',
    1,
    '[{"field_name": "patient_concerns", "prompt": "What are the main patient concerns about this trial?"}, {"field_name": "accessibility_issues", "prompt": "Are there accessibility or equity barriers to participation?"}, {"field_name": "communication_gaps", "prompt": "How could patient communication be improved?"}]'::jsonb,
    NULL,
    '#D97706'
);

-- =============================================================================
-- CONTRIBUTIONS (pre-populated so health chart starts with data)
-- =============================================================================

INSERT INTO contributions (id, quorum_id, role_id, user_token, content, structured_fields, tier_processed, created_at) VALUES
-- Principal Investigator
(
    gen_random_uuid(),
    '00000000-0000-0000-0000-000000000010',
    '00000000-0000-0000-0000-000000000101',
    'seed-pi-001',
    'Enrollment stall is primarily driven by overly restrictive inclusion criteria for the eGFR threshold. Recommend relaxing from >60 to >45 mL/min. Three sites need additional CRC staffing. Closing two sites would concentrate resources but lose geographic diversity.',
    '{"clinical_assessment": "eGFR threshold too restrictive — excluding 30% of otherwise eligible patients. Visit burden (12 in-person visits) also cited by 4 sites.", "protocol_recommendation": "Amend to eGFR >45, add telehealth for 4 of 12 visits, extend enrollment window by 6 months.", "site_strategy": "Place two lowest-enrolling sites on 90-day probation with dedicated CRC support before closing."}'::jsonb,
    1,
    now() - interval '1 hour 30 minutes'
),
-- IRB Chair
(
    gen_random_uuid(),
    '00000000-0000-0000-0000-000000000010',
    '00000000-0000-0000-0000-000000000102',
    'seed-irb-001',
    'eGFR relaxation requires updated risk-benefit analysis. Telehealth visits need separate informed consent addendum. Conditional approval possible if safety monitoring is enhanced for the expanded population.',
    '{"regulatory_concerns": "Lowering eGFR threshold changes risk profile — need updated DSMB charter with interim safety review at n=200 in expanded cohort.", "consent_assessment": "Current consent does not cover telehealth visits. Need addendum addressing remote assessment limitations and data privacy for video visits.", "conditional_approval": "Approve if: (1) DSMB interim review added, (2) telehealth consent addendum submitted, (3) renal AE reporting frequency increased to weekly."}'::jsonb,
    1,
    now() - interval '1 hour 15 minutes'
),
-- Sponsor Medical Monitor
(
    gen_random_uuid(),
    '00000000-0000-0000-0000-000000000010',
    '00000000-0000-0000-0000-000000000103',
    'seed-sponsor-001',
    'Sponsor willing to fund additional CRC positions at top 5 sites and extend timeline by 4 months. Budget ceiling is firm — cannot extend beyond Q2 2027. Closing sites is last resort due to FDA diversity requirements.',
    '{"risk_assessment": "Current trajectory reaches 65% enrollment by study end. Need 85% for statistical power. Gap is closable with protocol amendment.", "resource_commitment": "Funding for 5 additional CRCs, centralized recruitment campaign ($200K), and patient travel reimbursement program.", "timeline_constraint": "Hard stop Q2 2027. FDA pre-specified enrollment target must be met or study is underpowered for primary endpoint."}'::jsonb,
    1,
    now() - interval '1 hour'
),
-- Site Coordinator (Durham site)
(
    gen_random_uuid(),
    '00000000-0000-0000-0000-000000000010',
    '00000000-0000-0000-0000-000000000104',
    'seed-coord-durham',
    'Durham site at 62% enrollment. Main barrier is visit burden — patients dropping out after visit 6. Transportation is an issue for the elderly population. Would benefit greatly from telehealth option.',
    '{"enrollment_barriers": "12 in-person visits over 18 months. Elderly patients (median age 71) struggle with transportation. Competing trial at UNC offering fewer visits.", "patient_feedback": "Patients love the care team but say the visit schedule is unsustainable. Three patients cited parking costs.", "resource_needs": "Telehealth capability for follow-up visits, patient transportation stipend, and one additional CRC for evening/weekend slots."}'::jsonb,
    1,
    now() - interval '50 minutes'
),
-- Site Coordinator (Atlanta site)
(
    gen_random_uuid(),
    '00000000-0000-0000-0000-000000000010',
    '00000000-0000-0000-0000-000000000104',
    'seed-coord-atlanta',
    'Atlanta site at 31% enrollment. eGFR criterion is the primary barrier — large underserved population has higher rates of CKD. Relaxing threshold would immediately unlock ~40 pre-screened patients.',
    '{"enrollment_barriers": "eGFR >60 excludes most of our patient population. Also, consent document is 22 pages — patients are intimidated. No evening clinic hours.", "patient_feedback": "Patients willing to participate but fail screening. Community health workers report strong interest if criteria change.", "resource_needs": "Revised eGFR criteria, simplified consent summary sheet (plain language), evening clinic hours 2x/week."}'::jsonb,
    1,
    now() - interval '40 minutes'
),
-- Patient Advocate
(
    gen_random_uuid(),
    '00000000-0000-0000-0000-000000000010',
    '00000000-0000-0000-0000-000000000105',
    'seed-advocate-001',
    'Patient community is frustrated by the 22-page consent form and the number of required visits. Many potential participants are from communities that historically distrust clinical research. Need culturally sensitive outreach and simpler communication.',
    '{"patient_concerns": "Consent form is intimidating. Patients fear being a guinea pig. Visit schedule conflicts with work for hourly workers. No childcare support.", "accessibility_issues": "No materials in Spanish despite 28% Hispanic population at 3 sites. No evening or weekend appointments. Transportation cost not covered.", "communication_gaps": "Patients want to hear from other patients who completed the trial. No peer support program. Trial website is clinical and impersonal."}'::jsonb,
    1,
    now() - interval '25 minutes'
);

-- =============================================================================
-- ARTIFACT (draft — partially synthesized from contributions above)
-- =============================================================================

INSERT INTO artifacts (id, quorum_id, version, content_hash, sections, status, created_at)
VALUES (
    '00000000-0000-0000-0000-000000000201',
    '00000000-0000-0000-0000-000000000010',
    1,
    'sha256:seed-draft-v1',
    '[
        {
            "title": "Protocol Amendment Recommendations",
            "content": "1. Relax eGFR inclusion criterion from >60 to >45 mL/min/1.73m²\n2. Add telehealth option for 4 of 12 follow-up visits\n3. Extend enrollment window by 4-6 months (hard stop Q2 2027)\n4. Add simplified consent summary in plain language + Spanish translation",
            "source_roles": ["Principal Investigator", "Sponsor Medical Monitor", "Site Coordinator"],
            "status": "pending_review"
        },
        {
            "title": "IRB Conditions for Approval",
            "content": "1. DSMB interim safety review at n=200 in expanded eGFR cohort\n2. Telehealth consent addendum addressing remote assessment limitations\n3. Increased renal AE reporting frequency (weekly)\n4. Updated risk-benefit analysis for expanded population",
            "source_roles": ["IRB Chair"],
            "status": "conditionally_approved"
        },
        {
            "title": "Site Support Plan",
            "content": "1. Fund 5 additional CRC positions at top-enrolling sites\n2. Centralized recruitment campaign ($200K budget)\n3. Patient travel reimbursement program\n4. Evening/weekend clinic hours at 3 highest-potential sites\n5. 90-day probation period for two lowest sites before closure decision",
            "source_roles": ["Sponsor Medical Monitor", "Site Coordinator", "Principal Investigator"],
            "status": "pending_review"
        },
        {
            "title": "Patient Engagement Improvements",
            "content": "1. Plain-language consent summary (target: 6th grade reading level)\n2. Spanish-language materials for 3 sites with >20% Hispanic population\n3. Peer support program with trial completers\n4. Childcare reimbursement during study visits\n5. Patient-facing website redesign with testimonials and FAQ",
            "source_roles": ["Patient Advocate", "Site Coordinator"],
            "status": "pending_review"
        }
    ]'::jsonb,
    'draft',
    now() - interval '10 minutes'
);

-- =============================================================================
-- ARTIFACT VERSION (initial version snapshot)
-- =============================================================================

INSERT INTO artifact_versions (id, artifact_id, version, sections, diff, created_at)
VALUES (
    gen_random_uuid(),
    '00000000-0000-0000-0000-000000000201',
    1,
    (SELECT sections FROM artifacts WHERE id = '00000000-0000-0000-0000-000000000201'),
    '{"changes": "Initial draft generated from 6 contributions across 5 roles."}'::jsonb,
    now() - interval '10 minutes'
);
