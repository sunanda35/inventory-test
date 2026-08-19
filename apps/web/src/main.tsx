import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

const apiUrl = import.meta.env.VITE_API_URL ?? 'http://localhost:3001';

type User = { id: string; email: string; role: 'customer' | 'admin' };
type Product = {
  id: string;
  name: string;
  description: string;
  availableQuantity: number;
  version: number;
  active?: boolean;
};
type Reservation = {
  id: string;
  status: string;
  expiresAt: string;
  createdAt: string;
  customerEmail?: string;
  items: Array<{ productId: string; name: string; quantity: number }>;
};

async function request<T>(path: string, token?: string, options?: RequestInit): Promise<T> {
  const hasBody = options?.body !== undefined && options.body !== null;
  const response = await fetch(`${apiUrl}${path}`, {
    ...options,
    headers: {
      ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options?.headers,
    },
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message ?? 'Request failed.');
  return data;
}

function App() {
  const [session, setSession] = useState<{ token: string; user: User } | null>(() => {
    const saved = localStorage.getItem('inventory-session');
    return saved ? JSON.parse(saved) : null;
  });
  const [products, setProducts] = useState<Product[]>([]);
  const [reservations, setReservations] = useState<Reservation[]>([]);
  const [basket, setBasket] = useState<Record<string, number>>({});
  const [notice, setNotice] = useState('');
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [credentials, setCredentials] = useState({ email: '', password: '' });

  const load = async () => {
    const productData = await request<{ products: Product[] }>('/products');
    setProducts(productData.products);
    if (session) {
      const path = session.user.role === 'admin' ? '/admin/reservations' : '/reservations';
      const reservationData = await request<{ reservations: Reservation[] }>(path, session.token);
      setReservations(reservationData.reservations);
    }
  };

  useEffect(() => {
    void load().catch((error: Error) => setNotice(error.message));
  }, [session]);

  const basketItems = useMemo(
    () => products.filter((product) => basket[product.id]),
    [products, basket],
  );

  const authenticate = async (event: FormEvent) => {
    event.preventDefault();
    try {
      const data = await request<{ token: string; user: User }>(`/auth/${mode}`, undefined, {
        method: 'POST',
        body: JSON.stringify(credentials),
      });
      localStorage.setItem('inventory-session', JSON.stringify(data));
      setSession(data);
      setNotice(`Signed in as ${data.user.email}.`);
    } catch (error) {
      setNotice((error as Error).message);
    }
  };

  const changeQuantity = (product: Product, quantity: number) => {
    setBasket((current) => ({
      ...current,
      [product.id]: Math.max(0, Math.min(product.availableQuantity, quantity)),
    }));
  };

  const createReservation = async () => {
    if (!session) {
      setNotice('Sign in to reserve inventory.');
      return;
    }
    try {
      await request('/reservations', session.token, {
        method: 'POST',
        body: JSON.stringify({
          idempotencyKey: crypto.randomUUID(),
          items: basketItems.map((product) => ({
            productId: product.id,
            quantity: basket[product.id],
          })),
        }),
      });
      setBasket({});
      setNotice('Your inventory has been reserved for 10 minutes.');
      await load();
    } catch (error) {
      setNotice((error as Error).message);
      await load();
    }
  };

  const updateReservation = async (reservation: Reservation, action: 'confirm' | 'cancel') => {
    try {
      await request(`/reservations/${reservation.id}/${action}`, session?.token, {
        method: 'POST',
      });
      setNotice(`Reservation ${action}ed.`);
      await load();
    } catch (error) {
      setNotice((error as Error).message);
    }
  };

  const adjustStock = async (product: Product) => {
    const raw = window.prompt(
      `Adjust available stock for ${product.name}. Use a positive or negative number.`,
    );
    if (!raw) return;
    const quantityDelta = Number(raw);
    if (!Number.isInteger(quantityDelta) || quantityDelta === 0) {
      setNotice('Enter a non-zero whole number.');
      return;
    }
    const reason = window.prompt('Reason for this adjustment:');
    if (!reason) return;
    try {
      await request(`/admin/products/${product.id}/stock-adjustments`, session?.token, {
        method: 'POST',
        body: JSON.stringify({ quantityDelta, reason }),
      });
      await load();
    } catch (error) {
      setNotice((error as Error).message);
    }
  };

  return (
    <main>
      <header>
        <div>
          <p className="eyebrow">INVENTORY CONTROL</p>
          <h1>Reserve</h1>
        </div>
        <div className="session">
          {session ? (
            <>
              <span>{session.user.email}</span>
              <button
                className="secondary"
                onClick={() => {
                  localStorage.removeItem('inventory-session');
                  setSession(null);
                }}
              >
                Sign out
              </button>
            </>
          ) : (
            <span>Reserve stock with confidence</span>
          )}
        </div>
      </header>
      {notice && <p className="notice">{notice}</p>}
      {!session && (
        <section className="auth">
          <h2>{mode === 'login' ? 'Welcome back' : 'Create an account'}</h2>
          <form onSubmit={authenticate}>
            <label>
              Email
              <input
                type="email"
                required
                value={credentials.email}
                onChange={(event) => setCredentials({ ...credentials, email: event.target.value })}
              />
            </label>
            <label>
              Password
              <input
                type="password"
                minLength={8}
                required
                value={credentials.password}
                onChange={(event) =>
                  setCredentials({ ...credentials, password: event.target.value })
                }
              />
            </label>
            <button>{mode === 'login' ? 'Sign in' : 'Register'}</button>
          </form>
          <button className="link" onClick={() => setMode(mode === 'login' ? 'register' : 'login')}>
            {mode === 'login' ? 'Need an account?' : 'Already have an account?'}
          </button>
          <div className="hint">
            <p>
              Demo customers: customer@example.com, customer.two@example.com,
              customer.three@example.com
            </p>
            <p>Demo admin: admin@example.com</p>
            <p>All demo accounts use: Password123!</p>
          </div>
        </section>
      )}
      <section>
        <div className="section-heading">
          <div>
            <p className="eyebrow">AVAILABLE INVENTORY</p>
            <h2>Products</h2>
          </div>
          {session?.user.role === 'customer' && (
            <button disabled={!basketItems.length} onClick={createReservation}>
              Reserve{' '}
              {basketItems.length
                ? `${basketItems.length} item${basketItems.length === 1 ? '' : 's'}`
                : ''}
            </button>
          )}
        </div>
        <div className="product-grid">
          {products.map((product) => (
            <article className="card" key={product.id}>
              <div>
                <h3>{product.name}</h3>
                <p>{product.description}</p>
              </div>
              <strong>{product.availableQuantity} available</strong>
              {session?.user.role === 'customer' && (
                <div className="stepper">
                  <button
                    aria-label={`Remove ${product.name}`}
                    onClick={() => changeQuantity(product, (basket[product.id] ?? 0) - 1)}
                  >
                    -
                  </button>
                  <span>{basket[product.id] ?? 0}</span>
                  <button
                    aria-label={`Add ${product.name}`}
                    disabled={product.availableQuantity === 0}
                    onClick={() => changeQuantity(product, (basket[product.id] ?? 0) + 1)}
                  >
                    +
                  </button>
                </div>
              )}
              {session?.user.role === 'admin' && (
                <button className="secondary" onClick={() => adjustStock(product)}>
                  Adjust stock
                </button>
              )}
            </article>
          ))}
        </div>
      </section>
      {session && (
        <section>
          <div className="section-heading">
            <div>
              <p className="eyebrow">
                {session.user.role === 'admin' ? 'ALL CUSTOMER ACTIVITY' : 'YOUR ACTIVITY'}
              </p>
              <h2>Reservations</h2>
            </div>
          </div>
          <div className="reservation-list">
            {reservations.map((reservation) => (
              <article className="reservation" key={reservation.id}>
                <div>
                  <div className="row">
                    <span className={`status ${reservation.status}`}>{reservation.status}</span>
                    {reservation.customerEmail && <span>{reservation.customerEmail}</span>}
                  </div>
                  <p>
                    {reservation.items.map((item) => `${item.name} × ${item.quantity}`).join(', ')}
                  </p>
                  <small>
                    {reservation.status === 'pending'
                      ? `Expires ${new Date(reservation.expiresAt).toLocaleString()}`
                      : `Created ${new Date(reservation.createdAt).toLocaleString()}`}
                  </small>
                </div>
                {session.user.role === 'customer' && reservation.status === 'pending' && (
                  <div className="actions">
                    <button
                      className="secondary"
                      onClick={() => updateReservation(reservation, 'cancel')}
                    >
                      Cancel
                    </button>
                    <button onClick={() => updateReservation(reservation, 'confirm')}>
                      Confirm
                    </button>
                  </div>
                )}
              </article>
            ))}
            {!reservations.length && <p className="empty">No reservations yet.</p>}
          </div>
        </section>
      )}
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
