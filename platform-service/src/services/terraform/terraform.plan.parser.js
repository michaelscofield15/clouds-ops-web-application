/**
 * Parses and summarizes Terraform Plan JSON output and human-readable plan text.
 */
class TerraformPlanParser {
  /**
   * Parses structured JSON from `terraform show -json <planFile>`
   * @param {object} planJson JSON object from terraform show -json
   * @returns {object} Parsed summary
   */
  parseJsonPlan(planJson = {}) {
    const resourceChanges = planJson.resource_changes || [];
    const adds = [];
    const changes = [];
    const destroys = [];
    const readOnly = [];

    for (const rc of resourceChanges) {
      const actions = rc.change?.actions || [];
      const entry = {
        address: rc.address,
        moduleAddress: rc.module_address || null,
        type: rc.type,
        name: rc.name,
        actions: actions,
        actionSummary: this._formatActions(actions)
      };

      if (actions.includes('create') && actions.includes('delete')) {
        // Replace (destroy and recreate)
        destroys.push(entry);
        adds.push(entry);
      } else if (actions.includes('create')) {
        adds.push(entry);
      } else if (actions.includes('delete')) {
        destroys.push(entry);
      } else if (actions.includes('update')) {
        changes.push(entry);
      } else if (actions.includes('read') || actions.includes('no-op')) {
        readOnly.push(entry);
      }
    }

    const toAdd = adds.length;
    const toChange = changes.length;
    const toDestroy = destroys.length;
    const isIdempotent = toAdd === 0 && toChange === 0 && toDestroy === 0;
    const isDestructive = toDestroy > 0;

    return {
      toAdd,
      toChange,
      toDestroy,
      isIdempotent,
      isDestructive,
      summary: `Plan: ${toAdd} to add, ${toChange} to change, ${toDestroy} to destroy.`,
      resources: {
        add: adds,
        change: changes,
        destroy: destroys
      },
      allChanges: resourceChanges.map((rc) => ({
        address: rc.address,
        type: rc.type,
        name: rc.name,
        actions: rc.change?.actions || [],
        actionText: this._formatActions(rc.change?.actions || [])
      }))
    };
  }

  /**
   * Formats action array into a standard symbol and text (e.g. "+ create", "- destroy")
   */
  _formatActions(actions = []) {
    if (actions.includes('create') && actions.includes('delete')) {
      return '-/+ replace';
    }
    if (actions.includes('create')) {
      return '+ create';
    }
    if (actions.includes('delete')) {
      return '- destroy';
    }
    if (actions.includes('update')) {
      return '~ update in-place';
    }
    if (actions.includes('read')) {
      return '<= read';
    }
    return actions.join(', ') || 'no-op';
  }

  /**
   * Fallback text parser from `terraform plan` stdout
   */
  parseTextPlan(stdout = '') {
    const planMatch = stdout.match(/Plan:\s*(\d+)\s+to add,\s*(\d+)\s+to change,\s*(\d+)\s+to destroy/i);
    if (planMatch) {
      const toAdd = parseInt(planMatch[1], 10);
      const toChange = parseInt(planMatch[2], 10);
      const toDestroy = parseInt(planMatch[3], 10);
      return {
        toAdd,
        toChange,
        toDestroy,
        isIdempotent: toAdd === 0 && toChange === 0 && toDestroy === 0,
        isDestructive: toDestroy > 0,
        summary: `Plan: ${toAdd} to add, ${toChange} to change, ${toDestroy} to destroy.`
      };
    }

    const noChanges = /No changes\.\s*Your infrastructure matches the configuration/i.test(stdout);
    if (noChanges) {
      return {
        toAdd: 0,
        toChange: 0,
        toDestroy: 0,
        isIdempotent: true,
        isDestructive: false,
        summary: 'Plan: 0 to add, 0 to change, 0 to destroy (Infrastructure matches configuration).'
      };
    }

    return {
      toAdd: 0,
      toChange: 0,
      toDestroy: 0,
      isIdempotent: false,
      isDestructive: false,
      summary: 'Plan output received.'
    };
  }
}

module.exports = new TerraformPlanParser();
module.exports.TerraformPlanParser = TerraformPlanParser;
