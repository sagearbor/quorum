# Avatar Assets

This directory holds glTF/GLB avatar files for the 12 Quorum archetypes.

## Placeholder vs Production

By default, `scripts/setup-avatar-assets.sh` generates **procedural placeholder** avatars — colored box-body + box-head meshes with Duke blue shirts. These are valid glTF 2.0 files that load in Three.js / React Three Fiber.

## Replacing with Ready Player Me Avatars

To use real RPM full-body avatars:

1. Get a [Ready Player Me Partner API](https://docs.readyplayer.me/ready-player-me/api-reference) key and app ID.
2. Set environment variables:
   ```bash
   export RPM_API_KEY=your_key
   export RPM_APP_ID=your_app_id
   ```
3. Run the avatar creation script:
   ```bash
   bash scripts/create-rpm-avatars.sh
   ```
   This will create avatars via the RPM API and download GLBs here. Any that fail fall back to placeholders.

4. Or replace files manually — drop a full-body GLB for each archetype using the filenames below.

## Expected Files

| Archetype | Filename |
|---|---|
| medical_clinical | `medical.glb` (or `.gltf`) |
| researcher | `researcher.glb` |
| faculty | `faculty.glb` |
| student_grad | `grad_student.glb` |
| student_undergrad | `undergrad.glb` |
| administrator | `administrator.glb` |
| ethics | `ethics.glb` |
| engineer_tech | `tech.glb` |
| finance_ops | `finance.glb` |
| patient_participant | `patient.glb` |
| humanities_social | `humanities.glb` |
| neutral | `neutral.glb` |

## Requirements for Custom GLBs

- Full-body humanoid rig (RPM-compatible skeleton preferred)
- Must include ARKit morph targets for lip sync (`morphTargets=ARKit`)
- Texture atlas recommended (1024px) for performance
- The Duke blue material override is applied at runtime — shirt color in the GLB will be replaced
