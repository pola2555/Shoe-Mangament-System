import { useAuth } from '../context/AuthContext';
import { promptSuppressed } from '../utils/printQueuePrompt';

/**
 * Should this person be offered the print queue when stock lands?
 *
 * Two different answers, because they are two different questions:
 *
 *   canQueue    may they use the queue at all — the permission, and whether the page
 *               has been kept out of their way. Offering a feature somebody cannot
 *               reach is worse than not offering it.
 *   shouldOffer the above, AND they have not asked to stop being prompted.
 *
 * A page that only needs to decide which dialog to open imports this, not the dialog,
 * so the label renderer stays out of its chunk until something is actually printed.
 */
export default function useQueueOffer() {
  const { hasPermission, isPageHidden } = useAuth();
  const canQueue = hasPermission('print_queue', 'write') && !isPageHidden('/print-queue');
  return { canQueue, shouldOffer: canQueue && !promptSuppressed() };
}
