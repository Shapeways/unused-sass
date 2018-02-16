'use strict';

/**
 * This script will analyze any file in the cssFileGlob and check
 * portal files and the cms for unusedSelectors in those
 * files.
 *
 * At the same time it will also compile a list of nested selectors
 * and selectors longer than the defined selectorThreshold.
 *
 *
 *
 */

const fs = require('fs');
const path = require('path');
const glob = require('glob');
const css = require('css');
const _ = require('lodash');
const async = require('async');
const sourceMap = require('source-map');

const stringStripRegex = /{{2,3}[^{]+}{2,3}|<\?[^?'"]+\?>/g;
const nestLevelThreshold = 3;

/**
 * Generate the object of duplicate selectors - arrange the declaration (rule)
 * into a unique key and then add the selector to the array for that unique
 * declaration key.
 *
 * @type {{}}
 */
function addToDuplicateDeclarations(declarationsObject, selectors, declarations) {
  const declarationsObjectCopy = _.extend({}, declarationsObject);
  const declarationArray = _.reduce(declarations, function(declarationArray, declaration) {
    if (declaration.type === 'declaration') {
      declarationArray.push(declaration.property + ':' + declaration.value);
    }
    return declarationArray;
  }, []);
  const declarationKey = declarationArray.sort().join(';');
  if (declarationKey in declarationsObjectCopy) {
  if (declarationKey in declarationsObjectCopy) {
    declarationsObjectCopy[declarationKey].push(selectors);
  } else {
    declarationsObjectCopy[declarationKey] = [selectors];
  }
  return declarationsObjectCopy;
}

/**
 * Remove entries in the declarations object that are unique - that is the
 * decorations (rules) are unique to a single selector.
 *
 * @param declarationsObject
 */
function getNonSingleValueEntries(declarationsObject) {
  return _.reduce(_.keys(declarationsObject), function(declarationsObjectDuplicates, declarationKey) {
    if (declarationsObject[declarationKey].length > 1) {
      declarationsObjectDuplicates[declarationKey] = declarationsObject[declarationKey];
    }
    return declarationsObjectDuplicates
  }, {});
}

/**
 *
 * @param inputString
 * @returns {Array}
 */
function getAllSubClassesAndIds(inputString) {
  if (!inputString) {
    return [];
  }
  const selectors = inputString.match(/[.#][^.#+>~[:"',\f\n\r\t\v\x85 ]+/g);
  if (!selectors) {
    return [];
  }
  return _.map(selectors, function(string) {
    return string.substring(1);
  });
}

/**
 * Remove duplicates from an array even if
 * the array is of objects or nested arrays
 * by using JSON as the key to the object
 *
 * @param array
 */
function removeDuplicates(array) {
  return _.reduce(array, function(uniqObject, member) {
    const memberKey = JSON.stringify(member);
    if (!uniqObject[memberKey]) {
      uniqObject.push(member);
      uniqObject[memberKey] = true;
    }
    return uniqObject
  }, []);
}

/**
 *
 * @param array
 * @returns {Array.<*>}
 */
function organizeArrayByNumberOfEntriesPerMember(array) {
  const arraySorted = _.sortBy(array, 'selector');
  const arrayByNumberOfEntriesPerMember = _.reduce(arraySorted, function(arrayByNumberOfEntriesPerMember, member) {
    const lastMember = _.last(arrayByNumberOfEntriesPerMember);
    if (_.isMatch(lastMember, member)) {
      lastMember.occurrences++
    } else {
      member.occurrences = 1;
      arrayByNumberOfEntriesPerMember.push(member)
    }
    return arrayByNumberOfEntriesPerMember;
  }, []);
  return _.sortBy(arrayByNumberOfEntriesPerMember, 'occurrences').reverse();
}

/**
 *
 * @param selectors
 * @param sourceFile
 * @returns {Array}
 */
function getCssSelectorsWithSource(selectors, sourceFile) {
  const allSubClassesAndIds = _.flatten(_.map(selectors, getAllSubClassesAndIds));

  return _.map(allSubClassesAndIds, function(cssSelector) {
      return {
        selector: cssSelector,
        sourceFile: sourceFile
      }
    }
  );
}

/**
 * Pull rules out of media queries to create a flat list of rules.
 *
 * @param cssRules
 * @returns []
 */
function flattenCssRules(cssRules) {
  return _.reduce(cssRules, function (cssRules, rule) {
    if (rule.type === 'rule') {
      cssRules.push(rule);
    } else if (rule.type === 'media') {
      return cssRules.concat(flattenCssRules(rule.rules))
    }
    return cssRules;
  }, []);
}

/**
 * Collect all the css classes from the raw file data
 *
 * At the same time also collect any selectors that are nested
 * and any selectors that are longer than the defined selector threshold.
 *
 * @param cssFileName
 * @param data
 * @param smc
 * @returns []
 */
function analyzeCssFile(cssFileName, data, smc) {
  const cssObj = css.parse(data, { silent: true, source: cssFileName, sourcemap: 'generator'});
  const cssRules = flattenCssRules(cssObj.stylesheet.rules);
  return _.reduce(cssRules, function (cssFileResults, rule) {
    const sourceMapping = smc ? smc.originalPositionFor(rule.position.start) : null,
      sourceFile = sourceMapping ? sourceMapping.source : cssFileName;
    const nestedSelectors = _.reduce(rule.selectors, function(nestedSelectors, cssSelector) {
      const nestLevel = cssSelector.split(' ').length;
      if (nestLevel > nestLevelThreshold) {
        nestedSelectors.push({
          selector: cssSelector,
          sourceFile: sourceFile,
          nestLevel: nestLevel
        })
      }
      return nestedSelectors;
    }, []);
    cssFileResults.nestedSelectors = cssFileResults.nestedSelectors.concat(nestedSelectors);

    cssFileResults.duplicatedDeclarations =
      addToDuplicateDeclarations(cssFileResults.duplicatedDeclarations, rule.selectors, rule.declarations);

    const cssSelectorsWithSource = getCssSelectorsWithSource(rule.selectors, sourceFile);
    cssFileResults.cssSelectors = cssFileResults.cssSelectors.concat(cssSelectorsWithSource);
    return cssFileResults;
  }, {
    cssSelectors: [],
    nestedSelectors: [],
    duplicatedSelectors: [],
    duplicatedDeclarations: {}
  });
}

function getSourceMapForCssFile(mapFileName, cb) {
  if (mapFileName) {
    fs.readFile(mapFileName, 'utf-8', function fsStat(err, data) {
      if (err) {
        if (err.code === 'ENOENT') {
          return cb(null, false);
        } else {
          return cb(err);
        }
      }
      const smc = new sourceMap.SourceMapConsumer(data);

      return cb(null, smc);
    });
  }
}

// For each file in the glob, get all the css selectors
/**
 *
 * @param cb
 * @param searchIndex
 * @param cssFileGlob
 * @param cssFileGlobIgnore
 */
const analyzeAllCssFiles = function analyzeAllCssFiles(cb, searchIndex, cssFileGlob, cssFileGlobIgnore) {
  glob(cssFileGlob, {
    nodir: true,
    ignore: cssFileGlobIgnore
  }, function(er, cssFiles) {
    const numberOfFiles = cssFiles.length;
    async.reduce(cssFiles, {}, function (allCssFileResults, cssFileName, cb) {
      const mapFileName = cssFileName + '.map';
      async.waterfall(
        [function(cb) {
          return getSourceMapForCssFile(mapFileName, cb);
        },
          function(smc, cb) {
            fs.readFile(cssFileName, 'utf-8', function (err, data) {
              if (err) throw err;
              cb(null, analyzeCssFile(cssFileName, data, smc));
            });
          }
        ], function(err, cssFileResults) {
          // Sort the nested selectors by how nested they are
          cssFileResults.nestedSelectors = cssFileResults.nestedSelectors.sort(function(a, b) {
            return b.nestLevel - a.nestLevel;
          });
          // Sort the long selectors by their number of times they appear in the compiled css
          cssFileResults.duplicatedSelectors = organizeArrayByNumberOfEntriesPerMember(cssFileResults.cssSelectors);
          // Get entries that are actually duplicated (non-unique declarations)
          cssFileResults.duplicatedDeclarations = getNonSingleValueEntries(cssFileResults.duplicatedDeclarations);
          cssFileResults.duplicatedDeclarations = _.sortBy(_.map(_.keys(cssFileResults.duplicatedDeclarations),
            function(duplicatedDeclarationsKey) {
              return {
                declarations: duplicatedDeclarationsKey,
                selectors: cssFileResults.duplicatedDeclarations[duplicatedDeclarationsKey]
              }
            }
          ), function(a) {
            return a.selectors.length;
          });

          // Remove duplicated classes/fileSource from css selectors
          cssFileResults.cssSelectors = removeDuplicates(cssFileResults.cssSelectors);
          allCssFileResults[cssFileName] = cssFileResults;
          cb(null, allCssFileResults);
        });
    }, function (err, allCssFileResults) {
      const unusedSelectorsByFile = getUnusedSelectorsForFiles(searchIndex, allCssFileResults);

      cb(null, allCssFileResults);
    });
  });
};

function UsedAndUnusedSelectorsFromRule(selectors, searchIndex, removeRegex) {
  return _.reduce(selectors, function(usedAndUnusedRules, selector) {
    if (removeRegex && !selector.match(removeRegex)) {
      usedAndUnusedRules.usedSelectors.push(selector);
      return usedAndUnusedRules;
    }
    const subSelectors = getAllSubClassesAndIds(selector);
    const areSubSelectorsNotUsed = _.isUndefined(_.find(subSelectors, function(subSelector) {
      return subSelector in searchIndex;
    }));
    if (areSubSelectorsNotUsed) {
      usedAndUnusedRules.unusedSelectors.push(selector);
    } else {
      usedAndUnusedRules.usedSelectors.push(selector);
    }
    return usedAndUnusedRules;
  }, {
    usedSelectors: [],
    unusedSelectors: []
  });
}

/**
 *
 * @param cb
 * @param cssFileName
 * @param data
 * @param searchIndex
 * @param removeRegex
 */
function removeUnusedSelectorsForCssData(cb, cssFileName, data, searchIndex, removeRegex) {
  const cssObj = css.parse(data, { silent: true, source: cssFileName, sourcemap: 'generator'});
  const cssRulesByUsedAndUnused = _.reduce(cssObj.stylesheet.rules, function (cssRulesByUsedAndUnused, rule) {

    if (rule.type !== 'rule') {
      cssRulesByUsedAndUnused.usedRules.push(rule);
      return cssRulesByUsedAndUnused;
    }
    const selectorsByUsedAndUnused = UsedAndUnusedSelectorsFromRule(rule.selectors, searchIndex, removeRegex);
    if (selectorsByUsedAndUnused.unusedSelectors.length > 0) {
      cssRulesByUsedAndUnused.unusedSelectors =
        cssRulesByUsedAndUnused.unusedSelectors.concat(selectorsByUsedAndUnused.unusedSelectors);
    }

    // If no selectors are left, we will not be adding that rule to the new css file
    if (selectorsByUsedAndUnused.usedSelectors.length === 0) {
      return cssRulesByUsedAndUnused;
    }
    // Keep only the selectors that are used for the rule
    rule.selectors = selectorsByUsedAndUnused.usedSelectors;

    cssRulesByUsedAndUnused.usedRules.push(rule);
    return cssRulesByUsedAndUnused;
  }, {
    usedRules: [],
    unusedSelectors: []
  });
  cssObj.stylesheet.rules = cssRulesByUsedAndUnused.usedRules;
  const newCssFile = css.stringify(cssObj, {
    sourcemap: true,
    compress: true
  });
  async.parallel([
    function(cb) {
      fs.writeFile(cssFileName, newCssFile.code, function(err) {
        cb(err)
      });
    },
    function(cb) {
      fs.writeFile(cssFileName + '.map', newCssFile.map, function(err) {
        cb(err)
      });
    }
  ], function(err) {
    cb(err);
  });
}

/**
 *
 * @param cb
 * @param cssFileGlob
 * @param cssFileGlobIgnore
 * @param searchIndex
 * @param options
 */
function RemoveUnusedCssSelectorsForFiles(cb, cssFileGlob, cssFileGlobIgnore, searchIndex, options) {
  glob(cssFileGlob, {
    nodir: true,
    ignore: cssFileGlobIgnore
  }, function(er, cssFiles) {
    const numberOfFiles = cssFiles.length;
    async.reduce(cssFiles, {}, function (allCssFileResults, cssFileName, cb) {
      fs.readFile(cssFileName, 'utf-8', function (err, data) {
        if (err) throw err;
        removeUnusedSelectorsForCssData(cb, cssFileName, data, searchIndex, options.removeRegex);
      });
    }, function (err, allCssFileResults) {
      cb(null, allCssFileResults);
    });
  });
}

/**
 *
 *
 * @param selectors
 * @param searchIndex
 */
const getUnusedSelectorsBySelectorsAndSearchIndex =
  function getUnusedSelectorsBySelectorsAndSearchIndex(selectors, searchIndex) {
    return _.reduce(selectors, function(unusedSelectors, cssSelector) {
      if (!searchIndex[cssSelector.selector]) {
        const sourceFile = cssSelector.sourceFile;
        if (unusedSelectors[sourceFile]) {
          unusedSelectors[sourceFile].push(cssSelector.selector);
        } else {
          unusedSelectors[sourceFile] = [cssSelector.selector];
        }
      }
      return unusedSelectors;
    }, {});
  };

/**
 * All files to the list of unused selectors if they are not in any of the files in portal
 * and are not present in the cms_scheduled_content table
 *
 * @param cssAnalysisByFile
 * @param searchIndex
 */
const getUnusedSelectorsForFiles = function getUnusedSelectorsForFiles(searchIndex, cssAnalysisByFile) {
  return _.reduce(_.keys(cssAnalysisByFile), function (unusedSelectorsByFile, cssFileName) {
    const selectorsForFile = cssAnalysisByFile[cssFileName].cssSelectors;
    const unusedSelectors = getUnusedSelectorsBySelectorsAndSearchIndex(selectorsForFile, searchIndex);
    if (_.keys(unusedSelectors).length) {
      unusedSelectorsByFile[cssFileName] = unusedSelectors;
    }
    return unusedSelectorsByFile;
  }, {});
};

/**
 * Get all strings inside quotes from a string.
 *
 * Ex:
 *
 *  <div id="myId" class="myClass"> => ['myId', 'myClass']
 *
 *  Then I said "Hello old 'friend'" => ['Hello', 'old', 'friend']
 *
 * @param inputString
 * @returns {*}
 */
function getAllQuotedStringsAndPossibleSelectors(inputString) {
  if (!/['"].*['"]/.test(inputString)) {
    // Only add to the quoted strings array if the first char is not a special char
    return inputString ? [inputString] : [];
  }
  // Remove PHP and js comments
  const inputStringNoComments = inputString.replace(/\/\/[^\r\n]*|\/\*[\s\S]*?\*\//g, '');
  // Replace with the string strip regex, replace with a space in case there is not already one
  const inputStringNoCommentsClean = stringStripRegex ?
    inputStringNoComments.replace(stringStripRegex, ' ') : inputStringNoComments;
  // Match all text inside quotes
  const stringQuotes = _.reduce(inputStringNoCommentsClean.match(/(["'])(?:(?=(\\?))\2[\s\S])*?\1/g),
    function(stringQuotes, string) {
      // Split by white space characters and quotes
      return _.compact(stringQuotes.concat(string.split(/["'<>?:=\s]/)).concat(getAllSubClassesAndIds(string)));
    },
    []);
  return _.reduce(stringQuotes, function(stringsInQuotes, string) {
    // Strip the quotes and make a recursive call to get any recursive quoting
    return stringsInQuotes.concat(getAllQuotedStringsAndPossibleSelectors(string));
  }, []);
}

/**
 * Generate a search index for possible css classes from an input string
 *
 * @param dataString
 * @returns {{}}
 */
const getSearchIndexFromDataString = function getSearchIndexFromDataString(dataString) {
  const searchIndex = {};
  const dataArrayQuotes = getAllQuotedStringsAndPossibleSelectors(dataString);

  _.each(dataArrayQuotes, function(string) {
    if (string in searchIndex) {
      searchIndex[string]++;
    } else {
      searchIndex[string] = 1;
    }
  });

  const dataArrayClass = dataString ? dataString.match(/(class=|id=)[\w\-]+/g) : null;
  _.each(dataArrayClass, function(rawString) {
    const string = rawString.replace(/class=|id=/, '');
    if (string in searchIndex) {
      searchIndex[string]++;
    } else {
      searchIndex[string] = 1;
    }
  });

  return searchIndex;
};

/**
 * Collect all the files in portal that will need to be search for uses of the css selectors
 * and make a search string out of them
 *
 * @param cb
 * @param filesToSearchGlob
 * @param filesToSearchGlobIgnore
 */
const getSearchIndexFromFiles = function getSearchIndexFromFiles(cb, filesToSearchGlob, filesToSearchGlobIgnore) {
  glob(filesToSearchGlob, {
    'nodir': true,
    'ignore': filesToSearchGlobIgnore
  }, function(err, filesToSearch) {
    const numberOfFiles = filesToSearch.length;
    async.reduce(filesToSearch, {}, function (searchIndex, file, cb) {
      fs.readFile(file, 'utf-8', function (err, fileContents) {
        if (err) throw err;
        _.extend(searchIndex, getSearchIndexFromDataString(fileContents));

        cb(null, searchIndex);
      });
    }, function (err, searchIndex) {
      cb(null, searchIndex);
    });
  });
};

const removeUnusedSelectors = function removeUnusedSelectors(searchIndex, options) {
  if (!options) return false;
  if (options.cssFileGlob) {
    RemoveUnusedCssSelectorsForFiles(function(err) {
      if (err) throw err;
    }, options.cssFileGlob, options.cssFileGlobIgnore || null, searchIndex, options)
  }
};

module.exports = {
  analyzeAllCssFiles: analyzeAllCssFiles,
  getSearchIndexFromFiles: getSearchIndexFromFiles,
  getSearchIndexFromDataString: getSearchIndexFromDataString,
  removeUnusedSelectors: removeUnusedSelectors
};
