# Avatar Assets

This directory holds GLB avatar files for the 12 Quorum archetypes.

## Directory Structure

```
avatars/
├── *.glb                  — placeholder GLBs (ship in repo, always present)
├── avaturn/               — Avaturn-generated GLBs (generated via script, not committed)
│   └── *.glb
└── makehuman/             — MakeHuman-exported GLBs (generated via pipeline, not committed)
    └── *.glb
```

### Placeholder GLBs (`/avatars/`)

Procedural box-body + box-head meshes with Duke blue shirts. Valid glTF 2.0 files that
load in Three.js / React Three Fiber without any external tooling. Shipped in the repo so
the app works with zero setup.

### Avaturn GLBs (`/avatars/avaturn/`)

Full-body avatars generated via the Avaturn API. Run the generation script to populate
this directory. Files are not committed to the repo.

### MakeHuman GLBs (`/avatars/makehuman/`)

Full-body avatars exported from a MakeHuman pipeline. Run the export pipeline to populate
this directory. Files are not committed to the repo.

## Source Resolution

`resolveGlbUrl(archetype, preferredProvider?)` in
`src/components/avatar/archetypes/archetypes.ts` selects the URL at runtime:

1. If `preferredProvider` is supplied, try that source first.
2. Walk `glbSources` in order: `avaturn` → `makehuman` → `placeholder`.
3. The placeholder is always present, so a URL is always returned.

## Expected Filenames

Filenames use the archetype `id` for Avaturn and MakeHuman sources, and legacy names for
the placeholder source.

| Archetype            | Avaturn / MakeHuman filename       | Placeholder filename    |
|----------------------|------------------------------------|-------------------------|
| `medical_clinical`   | `medical_clinical.glb`             | `medical.glb`           |
| `researcher`         | `researcher.glb`                   | `researcher.glb`        |
| `faculty`            | `faculty.glb`                      | `faculty.glb`           |
| `student_grad`       | `student_grad.glb`                 | `grad_student.glb`      |
| `student_undergrad`  | `student_undergrad.glb`            | `undergrad.glb`         |
| `administrator`      | `administrator.glb`                | `administrator.glb`     |
| `ethics`             | `ethics.glb`                       | `ethics.glb`            |
| `engineer_tech`      | `engineer_tech.glb`                | `tech.glb`              |
| `finance_ops`        | `finance_ops.glb`                  | `finance.glb`           |
| `patient_participant`| `patient_participant.glb`          | `patient.glb`           |
| `humanities_social`  | `humanities_social.glb`            | `humanities.glb`        |
| `neutral`            | `neutral.glb`                      | `neutral.glb`           |

## GLB Requirements

All production GLBs (Avaturn and MakeHuman) must satisfy:

- **Humanoid rig** — standard humanoid skeleton with a named head bone (used for gaze
  and head-sway animation).
- **Head bone** — must be accessible by name so `VisionTracker` can drive it.
- **ARKit blend shapes** — 52 ARKit morph targets on the face mesh
  (`morphTargets=ARKit`) for lip sync driven by `EmotionDetector` / `StereoAnalyzer`.
- **Texture atlas** — 1024 px recommended for performance; avoid per-material textures.
- **Duke blue material** — shirt color is overridden at runtime; the GLB material value
  is ignored for shirt meshes.
