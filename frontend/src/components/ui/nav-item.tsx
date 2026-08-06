import type { ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import { cn } from '../../lib/utils';

export function NavItem({
  to,
  end,
  title,
  children,
}: {
  to: string;
  end?: boolean;
  title?: string;
  children: ReactNode;
}) {
  return (
    <NavLink
      to={to}
      end={end}
      title={title}
      className={({ isActive }) =>
        cn(
          'block rounded-md px-3 py-2 text-sm font-medium transition',
          isActive ? 'bg-brand-fg text-brand' : 'text-fg-muted hover:bg-subtle',
        )
      }
    >
      {children}
    </NavLink>
  );
}
