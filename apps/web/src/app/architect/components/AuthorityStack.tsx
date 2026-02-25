"use client";

import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
  arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useArchitectStore, type RoleDraft } from "@/store/architect";

function SortableChip({ role, index, total }: { role: RoleDraft; index: number; total: number }) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: role.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <div ref={setNodeRef} style={style} className="flex items-center gap-2">
      <div
        {...attributes}
        {...listeners}
        className="flex items-center gap-2 px-3 py-2 rounded-lg border-2 cursor-grab active:cursor-grabbing select-none w-full"
        style={{ borderColor: role.color, backgroundColor: `${role.color}15` }}
        data-testid={`authority-chip-${role.id}`}
      >
        <span className="text-gray-400 text-xs font-mono w-4">
          {total - index}
        </span>
        <span
          className="w-3 h-3 rounded-full flex-shrink-0"
          style={{ backgroundColor: role.color }}
        />
        <span className="font-medium text-sm flex-1">{role.name}</span>
        <span className="text-xs text-gray-500">
          {role.capacity === 1 ? "👤" : "👥"}
        </span>
      </div>
      {index < total - 1 && (
        <span className="text-[10px] text-gray-400 whitespace-nowrap absolute -bottom-3 left-1/2 -translate-x-1/2">
          overrides ↓
        </span>
      )}
    </div>
  );
}

export function AuthorityStack() {
  const { quorumDraft, reorderRoles } = useArchitectStore();
  const roles = quorumDraft.roles;

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const oldIndex = roles.findIndex((r) => r.id === active.id);
    const newIndex = roles.findIndex((r) => r.id === over.id);
    const reordered = arrayMove(roles, oldIndex, newIndex);
    // Recalculate authority_rank: top = highest rank
    const ranked = reordered.map((r, i) => ({
      ...r,
      authority_rank: reordered.length - i,
    }));
    reorderRoles(ranked);
  }

  function makePeerTier(roleId: string) {
    const idx = roles.findIndex((r) => r.id === roleId);
    if (idx <= 0) return;
    const prev = roles[idx - 1];
    const updated = roles.map((r) =>
      r.id === roleId ? { ...r, authority_rank: prev.authority_rank } : r
    );
    reorderRoles(updated);
  }

  if (roles.length === 0) {
    return (
      <div className="text-center text-gray-400 py-6 text-sm">
        Add roles above to build the authority hierarchy
      </div>
    );
  }

  return (
    <div data-testid="authority-stack">
      <h4 className="text-sm font-medium text-gray-700 mb-2">
        Authority Hierarchy
      </h4>
      <p className="text-xs text-gray-500 mb-3">
        Drag to reorder. Top role has highest authority.
      </p>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={handleDragEnd}
      >
        <SortableContext
          items={roles.map((r) => r.id)}
          strategy={verticalListSortingStrategy}
        >
          <div className="space-y-5" role="list" aria-label="Authority hierarchy">
            {roles.map((role, index) => (
              <div key={role.id} className="relative" role="listitem">
                <SortableChip
                  role={role}
                  index={index}
                  total={roles.length}
                />
                {index > 0 && (
                  <button
                    type="button"
                    onClick={() => makePeerTier(role.id)}
                    className="absolute -right-2 top-1/2 -translate-y-1/2 text-[10px] bg-gray-100 hover:bg-gray-200 rounded px-1.5 py-0.5 text-gray-500"
                    title="Make peer tier with role above"
                  >
                    = peer
                  </button>
                )}
              </div>
            ))}
          </div>
        </SortableContext>
      </DndContext>
    </div>
  );
}
