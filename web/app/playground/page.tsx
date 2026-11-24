import type { Metadata } from "next";
import { Playground } from "@/components/playground/playground";
import { Container, PageHeader } from "@/components/ui";

export const metadata: Metadata = {
  title: "Playground",
  description: "Watch a buyer agent pay the Verified Jobs API over x402 on testnet, step by step.",
};

export default function PlaygroundPage() {
  return (
    <>
      <PageHeader
        eyebrow="Playground"
        title="Watch an agent pay for an answer."
        lead="A buyer agent on the server pays the real API on testnet from its own wallet, within its owner's limits. Pick a posting and a payment method, and follow each step of the x402 exchange to the explorer."
      />
      <Container className="py-10">
        <Playground />
      </Container>
    </>
  );
}
