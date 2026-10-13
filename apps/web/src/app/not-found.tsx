import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="hero">
      <h1>Not here</h1>
      <p className="lede">That page does not exist.</p>
      <div className="actions">
        <Link className="button" href="/">
          Home
        </Link>
      </div>
    </div>
  );
}
