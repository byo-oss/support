import { createFileRoute } from "@tanstack/react-router";

// `/inbox/<ticket id>`: the parent route (`inbox.tsx`) reads `id` and opens the ticket in
// `<SupportInbox ticketId={id} />`; selecting another ticket navigates here again.
export const Route = createFileRoute("/inbox/$id")({});
