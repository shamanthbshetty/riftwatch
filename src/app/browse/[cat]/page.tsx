import ClientPage from "./client";

export function generateStaticParams() {
  return [
    { cat: "trending" },
    { cat: "popular" },
    { cat: "top-rated" },
    { cat: "movies-trending" },
    { cat: "tv-trending" },
    { cat: "movies-top" },
    { cat: "tv-top" },
  ];
}

export default function Page() {
  return <ClientPage />;
}
