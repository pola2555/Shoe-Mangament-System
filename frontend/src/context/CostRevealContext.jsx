import {
  createContext, useContext, useState, useEffect, useMemo,
} from 'react';
import { useLocation } from 'react-router-dom';

/**
 * Whether the costs on this page are currently on show.
 *
 * Cost is the one figure on these screens that must not be read over somebody's
 * shoulder: a customer who sees what a pair cost knows the margin before they open
 * their mouth. So every cost is blurred, and there are two ways past it — press and
 * hold one value to see that one, or turn the eye on to show the lot while working.
 *
 * WHAT THIS IS NOT: the number is still in the page and still in the API response.
 * This hides it from the room, not from anybody with a browser's developer tools. The
 * real control over who may see cost is the permission check on the server
 * (`middleware/priceVisibility`), which never sends the figure at all to someone who
 * is not allowed it. This is for the person who IS allowed it and does not want it on
 * display.
 *
 * RESET ON NAVIGATION, deliberately. Turning the eye on is a decision about the screen
 * in front of you — "I am doing stock costing now" — not a setting. Carrying it to the
 * next page would mean an eye switched on in the back office is still on at the
 * counter an hour later, which is the exact situation the blur exists for.
 */
const CostRevealContext = createContext({ revealAll: false, setRevealAll: () => {}, hasCosts: false });

export function CostRevealProvider({ children }) {
  const [revealAll, setRevealAll] = useState(false);
  const location = useLocation();

  useEffect(() => { setRevealAll(false); }, [location.pathname]);

  const value = useMemo(() => ({ revealAll, setRevealAll }), [revealAll]);
  return <CostRevealContext.Provider value={value}>{children}</CostRevealContext.Provider>;
}

export function useCostReveal() {
  return useContext(CostRevealContext);
}

export default CostRevealContext;
