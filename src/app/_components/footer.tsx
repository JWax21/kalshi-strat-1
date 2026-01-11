import Container from "@/app/_components/container";

export function Footer() {
  return (
    <footer className="bg-slate-900 border-t border-slate-800">
      <Container>
        <div className="py-8 text-center text-slate-500 text-sm">
          <p>
            Kalshi Underdogs Fund • Data from{" "}
            <a
              href="https://kalshi.com"
              target="_blank"
              rel="noopener noreferrer"
              className="text-emerald-400 hover:underline"
            >
              Kalshi
            </a>
          </p>
        </div>
      </Container>
    </footer>
  );
}

export default Footer;
