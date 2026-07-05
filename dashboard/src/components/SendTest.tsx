import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import { api } from '../lib/api';
import { Button, Field, Input, Modal, Mono } from '../ui';

interface TriggerResult {
  transactionId: string;
  duplicate?: boolean;
}

/**
 * Fire a real trigger from the dashboard — the "does it work?" button.
 * The optional transaction id makes idempotency testable from the UI:
 * send twice with the same id and the second comes back as a duplicate.
 */
export function SendTestModal({
  workflowKey,
  onClose,
}: {
  workflowKey: string;
  onClose: () => void;
}) {
  const [payloadError, setPayloadError] = useState('');
  const [result, setResult] = useState<TriggerResult | null>(null);

  const send = useMutation({
    mutationFn: (body: unknown) =>
      api<TriggerResult>('/v1/events/trigger', { method: 'POST', body }),
    onSuccess: (res) => setResult(res),
  });

  return (
    <Modal open onClose={onClose} title={`Send test — ${workflowKey}`}>
      {result ? (
        <div className="space-y-3">
          <p className="text-t2">
            {result.duplicate
              ? 'Duplicate transaction id — nothing was re-sent (idempotency).'
              : 'Accepted. Delivery is in flight.'}
          </p>
          <p>
            <Mono className="text-t2">{result.transactionId}</Mono>
          </p>
          <div className="flex justify-end gap-2">
            <Button onClick={() => setResult(null)}>Send another</Button>
            <Link to={`/activity/${encodeURIComponent(result.transactionId)}`} onClick={onClose}>
              <Button variant="primary">View in activity</Button>
            </Link>
          </div>
        </div>
      ) : (
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            const form = new FormData(e.currentTarget);
            let payload: unknown = {};
            const rawPayload = String(form.get('payload') ?? '').trim();
            if (rawPayload) {
              try {
                payload = JSON.parse(rawPayload);
              } catch {
                setPayloadError('Payload must be valid JSON');
                return;
              }
            }
            setPayloadError('');
            const to: Record<string, string> = {
              subscriberId: String(form.get('subscriberId') || 'test-user'),
            };
            const email = String(form.get('email') ?? '').trim();
            const phone = String(form.get('phone') ?? '').trim();
            if (email) to.email = email;
            if (phone) to.phone = phone;
            const transactionId = String(form.get('transactionId') ?? '').trim();
            send.mutate({
              workflowKey,
              to: [to],
              payload,
              ...(transactionId ? { transactionId } : {}),
            });
          }}
        >
          <div className="grid grid-cols-2 gap-3">
            <Field label="Subscriber ID">
              <Input name="subscriberId" defaultValue="test-user" className="font-mono" />
            </Field>
            <Field label="Email">
              <Input name="email" type="email" defaultValue="test@example.com" />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Phone (optional)">
              <Input name="phone" placeholder="+15550001111" />
            </Field>
            <Field label="Transaction ID (optional)" hint="Reuse one to test idempotency">
              <Input name="transactionId" className="font-mono" placeholder="auto-generated" />
            </Field>
          </div>
          <Field label="Payload (JSON)" hint="Variables available to your {{templates}}">
            <textarea
              name="payload"
              rows={4}
              className="w-full rounded-md border border-bd bg-transparent p-2.5 font-mono text-[12px] text-t1 hover:border-bd-strong"
              defaultValue={'{\n  "name": "Ada",\n  "orderId": "ORD-1",\n  "carrier": "BlueDart",\n  "eta": "Monday"\n}'}
            />
          </Field>
          {payloadError && <p className="text-[12px] text-err">{payloadError}</p>}
          {send.isError && <p className="text-[12px] text-err">{send.error.message}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" type="submit" disabled={send.isPending}>
              {send.isPending ? 'Sending…' : 'Send test'}
            </Button>
          </div>
        </form>
      )}
    </Modal>
  );
}
