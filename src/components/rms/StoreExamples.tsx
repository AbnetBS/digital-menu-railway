'use client';

/* These are display-only examples. They never enter the inventory database. */
const examples = [
  {
    name: 'Roasted coffee beans',
    amount: '8 kg',
    warning: '2 kg',
    image: '/store-examples/coffee.jpg',
  },
  {
    name: 'Fresh milk',
    amount: '24 L',
    warning: '5 L',
    image: '/store-examples/milk.jpg',
  },
  {
    name: 'Eggs',
    amount: '60 pcs',
    warning: '12 pcs',
    image: '/store-examples/eggs.jpg',
  },
];

export default function StoreExamples({
  onDismiss,
  theme = 'white',
}: {
  onDismiss: () => void;
  theme?: 'brown' | 'white';
}) {
  const isBrown = theme === 'brown';
  return (
    <section
      aria-label="Example stock items"
      className={
        isBrown
          ? 'mb-5 rounded-2xl border border-[#C9A227]/40 bg-[#2C1B17] p-4 sm:p-5'
          : 'mb-5 rounded-2xl border border-amber-200 bg-amber-50 p-4 sm:p-5'
      }
    >
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3
            className={
              isBrown ? 'font-black text-amber-100' : 'font-black text-amber-950'
            }
          >
            Example stock items
          </h3>
          <p
            className={
              isBrown
                ? 'mt-1 text-sm text-amber-200/80'
                : 'mt-1 text-sm text-amber-900'
            }
          >
            These pictures and quantities are examples only, not your actual
            stock. They cannot be requested or used in recipes and do not affect
            reports. They disappear when you add your first real item.
          </p>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          className={
            isBrown
              ? 'rounded-xl border border-[#C9A227]/50 bg-[#1C120F] px-4 py-2 text-sm font-bold text-[#F5D061] hover:bg-[#3A241E]'
              : 'rounded-xl border border-amber-300 bg-white px-4 py-2 text-sm font-bold text-amber-950 hover:bg-amber-100'
          }
        >
          Remove examples
        </button>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {examples.map((item) => (
          <article
            key={item.name}
            className={
              isBrown
                ? 'overflow-hidden rounded-2xl border border-[#C9A227]/30 bg-[#221512]'
                : 'overflow-hidden rounded-2xl border border-amber-200 bg-white'
            }
          >
            {/* Local illustration assets are used instead of external image services. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={item.image}
              alt={item.name}
              loading="lazy"
              decoding="async"
              className="h-36 w-full object-cover"
            />
            <div className="p-4">
              <div className="flex items-center justify-between gap-2">
                <h4
                  className={
                    isBrown
                      ? 'font-black text-amber-50'
                      : 'font-black text-stone-900'
                  }
                >
                  {item.name}
                </h4>
                <span
                  className={
                    isBrown
                      ? 'rounded-full bg-[#C9A227]/20 px-2 py-1 text-[10px] font-black uppercase tracking-wide text-[#F5D061]'
                      : 'rounded-full bg-amber-100 px-2 py-1 text-[10px] font-black uppercase tracking-wide text-amber-800'
                  }
                >
                  Example
                </span>
              </div>
              <p
                className={
                  isBrown
                    ? 'mt-2 text-xs text-amber-200/65'
                    : 'mt-2 text-xs text-stone-500'
                }
              >
                Example amount
              </p>
              <p
                className={
                  isBrown
                    ? 'text-xl font-black text-amber-50'
                    : 'text-xl font-black text-stone-900'
                }
              >
                {item.amount}
              </p>
              <p
                className={
                  isBrown
                    ? 'mt-1 text-xs text-amber-200/65'
                    : 'mt-1 text-xs text-stone-500'
                }
              >
                Example warning at {item.warning}
              </p>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
