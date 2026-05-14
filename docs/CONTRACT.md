env_vars:
  NEXT_PUBLIC_AVATAR_CHOREOGRAPHY:
    type: enum
    values: [full, bust_only]
    default: full
    description: >
      Avatar choreography mode. `full` runs the four-state walk-and-bust
      state machine driven by VisionTracker presence (idle_pacing →
      approach → talking → retreating). `bust_only` short-circuits to
      bust framing always (no walking, no Z motion, no vision-driven
      transitions). Expo safety net — flip to `bust_only` if the
      choreography misbehaves at the venue.
    consumed_by: apps/web/src/components/avatar/useAvatarController.ts
