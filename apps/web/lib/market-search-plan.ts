export function searchProviderPlan(query: string): "japan" | "global" | "both" {
  if (/^[0-9]{3,4}[A-Za-z]?$/u.test(query)) return "japan";
  if (/^[A-Za-z0-9.^ -]{1,31}$/u.test(query)) return "global";
  return "both";
}
