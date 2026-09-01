import type { ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import { cn } from '../../lib/utils';

export function NavItem({
  to,
  end,
  title,
  active,
  children,
}: {
  to: string;
  end?: boolean;
  title?: string;
  /**
   * Force the active styling regardless of the URL match.
   *
   * For a section parent whose `to` points at its default child: on any other
   * subpage the link doesn't match, so the parent would render inactive while
   * the reader is plainly inside it.
   */
  active?: boolean;
  children: ReactNode;
}) {
  return (
    <NavLink
      to={to}
      end={end}
      title={title}
      className={({ isActive }) =>
        cn(
          'block rounded-sm px-3 py-2 text-sm font-medium transition',
          active ?? isActive
            ? 'bg-brand-fg text-brand-muted'
            : 'text-fg-muted hover:bg-subtle',
        )
      }
    >
      {children}
    </NavLink>
  );
}
