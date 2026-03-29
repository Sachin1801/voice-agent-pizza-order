/**
 * Result Assembler.
 *
 * Builds the final CallResult JSON from the order state,
 * generates the summary markdown, and writes all closing artifacts.
 */

import { CallResult, CallOutcome, OrderRequest } from '../types';
import { Logger } from '../logging/logger';
import { ArtifactWriter, MetricsData } from '../logging/artifact-writer';
import { generateSummary, SummaryInput } from '../logging/summary-writer';
import { CallEvent } from '../logging/event-schema';
import { OrderState } from '../conversation/rule-engine';

export class ResultAssembler {
  private logger: Logger;

  constructor(parentLogger: Logger) {
    this.logger = parentLogger.child('session');
  }

  /** Build the final CallResult from order state */
  buildResult(
    outcome: CallOutcome,
    order: OrderRequest,
    orderState: OrderState
  ): CallResult {
    const result: CallResult = {
      outcome,
      pizza: orderState.pizzaConfirmed
        ? {
            description: this.buildPizzaDescription(order, orderState),
            substitutions: orderState.substitutions,
            price: orderState.pizzaPrice ?? 0,
          }
        : null,
      side: orderState.sideConfirmed
        ? {
            description: orderState.sideDescription ?? order.side.first_choice,
            original: order.side.first_choice,
            price: orderState.sidePrice ?? 0,
          }
        : null,
      drink: orderState.drinkConfirmed
        ? {
            description: orderState.drinkDescription ?? order.drink.first_choice,
            price: orderState.drinkPrice ?? 0,
          }
        : orderState.drinkSkipped
        ? null
        : null,
      total: orderState.runningTotal || null,
      delivery_time: orderState.deliveryTime,
      order_number: orderState.orderNumber,
      special_instructions_delivered: orderState.specialInstructionsDelivered,
    };

    this.logger.info('session.result_assembled', `Result: outcome=${outcome}, total=$${result.total}`, {
      outcome,
      total: result.total,
      pizza: result.pizza ? 'yes' : 'no',
      side: result.side ? 'yes' : 'no',
      drink: result.drink ? 'yes' : 'skipped',
    });

    return result;
  }

  /** Build pizza description string with substitutions applied */
  private buildPizzaDescription(order: OrderRequest, state: OrderState): string {
    const toppings = order.pizza.toppings.map((t) => {
      const sub = state.substitutions[t];
      return sub ?? t;
    });
    return `${order.pizza.size} ${order.pizza.crust} with ${toppings.join(', ')}`;
  }

  /** Write all closing artifacts (result, summary, metrics) */
  async writeClosingArtifacts(
    artifacts: ArtifactWriter,
    result: CallResult,
    events: CallEvent[],
    callId: string,
    startTime: string,
    metrics: MetricsData
  ): Promise<void> {
    // Write result
    artifacts.writeResult(result);

    // Write metrics
    artifacts.writeMetrics(metrics);

    // Generate and write summary
    const summaryInput: SummaryInput = {
      callId,
      startTime,
      endTime: new Date().toISOString(),
      events,
      result,
    };
    const summary = generateSummary(summaryInput);
    artifacts.writeSummary(summary);

    // Close streams
    await artifacts.close();

    this.logger.info('session.artifacts_finalized', 'All closing artifacts written', {
      run_dir: artifacts.getRunDir(),
    });
  }
}
