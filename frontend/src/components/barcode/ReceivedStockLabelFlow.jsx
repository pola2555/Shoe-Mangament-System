import { useState, useRef, lazy, Suspense } from 'react';
import toast from 'react-hot-toast';
import { printQueueAPI } from '../../api';
import { useTranslation } from '../../i18n/i18nContext';
import { useConfirm } from '../common/ConfirmDialog';
import AddToPrintQueueModal from './AddToPrintQueueModal';

const PrintLabelsModal = lazy(() => import('./PrintLabelsModal'));

/**
 * What happens the moment stock lands on the shelf.
 *
 * Both places that create stock — completing a purchase box and posting a stock intake
 * — want the same three-step offer, and it is fiddly enough (queue, then optionally
 * print, then optionally tick off) that two copies would drift. So it lives here and
 * each page renders one element.
 *
 *   1. "Shall I queue these labels?"  — the only moment anybody knows what just arrived.
 *   2. "Add and print now"            — for the shop that prints at the same desk.
 *   3. "Mark them printed?"           — asked, never assumed. A browser cannot see
 *                                       whether the dialog was cancelled or the paper
 *                                       jammed; only the person watching can say.
 *
 * `hooks/useQueueOffer` decides whether step 1 happens at all, and the page asks it
 * BEFORE mounting this: somebody without the queue permission, or with the page hidden,
 * gets the old straight-to-print dialog instead of a feature they cannot use. It is a
 * separate module for the same reason this one is lazy — asking the question must not
 * download the answer.
 */

export default function ReceivedStockLabelFlow({ sourceType, sourceId, title, onClose }) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const [queueIds, setQueueIds] = useState(null);
  // The queue dialog always closes after it saves, so its onClose has to know whether
  // that close is the end of the flow or a hand-over to the print dialog. A ref, not
  // state: it is read inside the same tick that sets it.
  const handingOver = useRef(false);

  async function afterPrint(total, copies, labelRows) {
    // Record what was PRINTED, not what was owed.
    //
    // The copies box in the print dialog is editable, so somebody with five labels left
    // on the roll lowers a run of twenty to five and prints. Sending the row id with no
    // quantity tells the server "all of it", and it would mark all twenty done — fifteen
    // labels recorded as printed that never were, gone from the queue with nothing to
    // say so. That is precisely the failure this queue exists to prevent, arriving from
    // the other direction.
    const items = [];
    for (const r of labelRows) {
      let left = Number(copies[r.variant_id]) || 0;
      // These rows were created a moment ago by this same flow, so each variant maps to
      // exactly one queue row and nothing has been printed against it yet. Pouring the
      // count across queue_ids in order still handles the case where it does not.
      for (const id of (r.queue_ids || [])) {
        if (left <= 0) break;
        items.push({ id, quantity: left });
        left = 0;
      }
    }
    if (!items.length) return;

    const ok = await confirm({
      title: t('print_queue.mark_printed_title'),
      message: t('print_queue.mark_printed_confirm', { count: total }),
      confirmText: t('print_queue.mark_printed'),
      cancelText: t('print_queue.not_yet'),
    });
    if (!ok) return;

    try {
      const { data } = await printQueueAPI.markPrinted(items);
      toast.success(t('print_queue.marked', { count: data.data.labels }));
      window.dispatchEvent(new CustomEvent('print-queue-changed'));
    } catch (err) {
      toast.error(err.response?.data?.message || t('common.failed'));
    }
  }

  // The print dialog replaces the queue dialog rather than stacking on it — two
  // overlays deep is where a modal stops reading as a modal.
  if (queueIds) {
    return (
      <Suspense fallback={null}>
        <PrintLabelsModal
          queueIds={queueIds}
          title={title}
          onPrinted={afterPrint}
          onClose={onClose}
        />
      </Suspense>
    );
  }

  return (
    <AddToPrintQueueModal
      sourceType={sourceType}
      sourceId={sourceId}
      title={title}
      onQueued={(rows, thenPrint) => {
        if (thenPrint && rows.length) {
          handingOver.current = true;
          setQueueIds(rows.map((r) => r.id));
        }
      }}
      onClose={() => {
        if (handingOver.current) { handingOver.current = false; return; }
        onClose();
      }}
    />
  );
}
