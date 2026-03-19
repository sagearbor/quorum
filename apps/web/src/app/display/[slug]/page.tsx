"use client";

import { useParams } from "next/navigation";
import { redirect } from "next/navigation";

/** Legacy route — redirects to /event/{slug}/dashboard */
export default function DisplayRedirect() {
  const params = useParams<{ slug: string }>();
  redirect(`/event/${params.slug}/dashboard`);
}
