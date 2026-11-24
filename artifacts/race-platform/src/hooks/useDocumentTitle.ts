import { useEffect } from "react";
import { useLocation } from "wouter";
import { fullTitle, routeTitle } from "@/lib/documentTitle";

/** Sets the tab title from the route on every navigation (mounted once, before the routes). */
export function useRouteTitle() {
  const [location] = useLocation();
  useEffect(() => {
    document.title = routeTitle(location);
  }, [location]);
}

/**
 * A page's own tab title ("Turkey Trot MX · RM Roost"). Pass null until the
 * name has loaded; the route's default stays meanwhile and comes back on leave.
 */
export function useDocumentTitle(title: string | null | undefined) {
  const [location] = useLocation();
  useEffect(() => {
    if (!title || !title.trim()) return;
    document.title = fullTitle(title);
    // On leaving, the route default; RouteTitle then sets the next route's.
    return () => { document.title = routeTitle(location); };
  }, [title, location]);
}
