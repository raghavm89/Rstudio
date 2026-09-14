import { redirect } from "next/navigation";

// The per-avatar Shoot form was replaced by /create (describe an idea or pick a
// template). Anything still pointing here lands on the new content hub.
export default function Page({ params }) {
  redirect(`/avatars/${params.id}/create`);
}
