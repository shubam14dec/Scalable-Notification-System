import { Link, useLocation } from 'react-router-dom';
import { Button, Mono } from '../ui';
import { RippleMark } from './auth/AuthLayout';

/**
 * The 404, spoken in the product's own vocabulary: a path nobody routes is a
 * delivery with no recipient. Lives INSIDE the authed shell (the sidebar stays,
 * because the fix for a wrong URL is usually one click away on it); signed-out
 * visitors never reach this — RequireAuth bounces them to /login first.
 */
export default function NotFoundPage() {
  const { pathname } = useLocation();
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center text-center">
      <RippleMark size={28} className="text-t3" />
      <p className="mt-6 font-mono text-[44px] font-medium leading-none text-t1">404</p>
      <p className="mt-3 text-[14px] text-t2">This page doesn&#39;t deliver.</p>
      <p className="mt-1 text-[12px] text-t3">
        Nothing is routed at <Mono className="text-t2">{pathname}</Mono>
      </p>
      <Link to="/" className="mt-6">
        <Button variant="primary" type="button">
          Back to Overview
        </Button>
      </Link>
    </div>
  );
}
