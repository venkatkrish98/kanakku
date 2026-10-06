import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Kanakku — AI Accounting Copilot for Indian SMBs',
  description:
    'Alexa+-style conversational web simulator and GST financial console powered by Amazon Bedrock and Model Context Protocol.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
